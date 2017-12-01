const http = require ( 'http' );
const request = require ( 'request' );
const createHandler = require ( 'github-webhook-handler' );
const url = require( 'url' );

const calypsoProject = process.env.CALYPSO_PROJECT || 'Automattic/wp-calypso';
const wpDesktopProject = process.env.DESKTOP_PROJECT || 'Automattic/wp-desktop';
const flowPatrolOnly = process.env.FLOW_PATROL_ONLY || 'false';

const flowPatrolUsernames = [ 'alisterscott', 'brbrr', 'bsessions85', 'hoverduck', 'rachelmcr', 'designsimply', 'astralbodies' ];
const triggerLabel = process.env.TRIGGER_LABEL || '[Status] Needs Review';

const gitHubStatusURL = `https://api.github.com/repos/${ calypsoProject }/statuses/`;
const gitHubDesktopBranchURL = `https://api.github.com/repos/${ wpDesktopProject }/branches/`;

const gitHubWebHookPath = '/ghwebhook';
const circleCIWebHookPath = '/circleciwebhook';
const healthCheckPath = '/cache-healthcheck';

const prContext = 'ci/wp-desktop';

const handler = createHandler( { path: gitHubWebHookPath, secret: process.env.BRIDGE_SECRET } );

http.createServer(function (req, res) {
    const fullUrl = req.url;
    const path = fullUrl.split( '?' )[0];
    if ( path === gitHubWebHookPath ) {
        handler(req, res, function (err) {
            res.statusCode = 404;
            res.end('invalid location');
        });
    } else if ( path === healthCheckPath ) {
        res.statusCode = 200;
        res.end( 'OK' );
    } else if ( path === circleCIWebHookPath ) {
        console.log( "Called from CircleCI" );
        let body = [];
        req.on( 'data', function( chunk ) {
            body.push( chunk );
        } ).on( 'end', function() {
            body = Buffer.concat( body ).toString();
            try {
                let payload = JSON.parse( body ).payload;
                if ( payload && payload.build_parameters && payload.build_parameters.sha && payload.build_parameters.calypsoProject === calypsoProject ) {
                    let status, desc;
                    if (payload.outcome === 'success') {
                        status = 'success';
                        desc = 'Your PR passed the wp-desktop tests on CircleCI!';
                    } else if (payload.outcome === 'failed') {
                        status = 'failure';
                        desc = `wp-desktop test status: ${payload.status}`;
                    } else {
                        status = 'error';
                        desc = `wp-desktop test status: ${payload.status}`;
                    }
                    // POST to GitHub to provide status
                    let gitHubStatus = {
                        state: status,
                        description: desc,
                        target_url: payload.build_url,
                        context: prContext
                    };
                    request.post( {
                        headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
                        url: gitHubStatusURL + payload.build_parameters.sha,
                        body: JSON.stringify( gitHubStatus )
                    }, function( error ) {
                        if ( error ) {
                            console.log( `ERROR: ${error}` );
                        }
                        console.log( 'GitHub status updated' );
                    } );
                }
            } catch ( e ) {
                console.log( 'Non-CircleCI packet received' );
            }
            res.statusCode = 200;
            res.end( 'ok' );
        } );
    } else {
        console.log( 'unknown location', fullUrl );
        res.statusCode = 404;
        res.end( 'no such location' );
    }
}).listen( process.env.PORT || 7777 );

handler.on('error', function (err) {
    console.error('Error:', err.message);
});

handler.on('pull_request', function (event) {
    const pullRequestNum = event.payload.pull_request.number;
    const pullRequestStatus = event.payload.pull_request.state;
    const loggedInUsername = event.payload.sender.login;
    const pullRequestHeadLabel = event.payload.pull_request.head.label;
    const repositoryName = event.payload.repository.full_name;


    // Check if we should only run for certain users
    if( flowPatrolOnly === 'true' && flowPatrolUsernames.indexOf( loggedInUsername ) === -1 ) {
        console.log(  `Ignoring pull request '${ pullRequestNum }' as we're only running for certain users and '${ loggedInUsername }' is not in '${ flowPatrolUsernames }'` );
        return true;
    }

    // Make sure the PR is in the correct repository
    if ( repositoryName !== calypsoProject ) {
        console.log(  `Ignoring pull request '${ pullRequestNum }' as the repository '${ repositoryName }' is not '${ calypsoProject }'` );
        return true;
    }

    // Make sure the PR is still open
    if ( pullRequestStatus !== 'open' ) {
        console.log(  `Ignoring pull request '${ pullRequestNum }' as the status '${ pullRequestStatus }' is not 'open'` );
        return true;
    }

    // Ignore OSS requests - check for location of head to indicate forks
    if ( event.payload.pull_request.head.label.indexOf( 'Automattic:' ) !== 0 ) {
        console.log(  `Ignoring pull request '${ pullRequestNum }' as this is from a fork: '${ pullRequestHeadLabel }'` );
        return true;
    }

    if ( event.payload.action === 'labeled' && event.payload.label.name === triggerLabel ) {
        const wpCalypsoBranchName = event.payload.pull_request.head.ref;
        let wpDesktopBranchName;
        console.log( 'Executing wp-desktop tests for wp-calypso branch: \'' + wpCalypsoBranchName + '\'' );

        // Check if there's a matching branch in the wp-desktop repository
        request.get( {
            headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
            url: gitHubDesktopBranchURL + wpCalypsoBranchName,
        }, function( err, response ) {
            if ( response.statusCode === 200 ) {
                wpDesktopBranchName = wpCalypsoBranchName;
            } else {
                wpDesktopBranchName = 'develop';
            }

            const triggerBuildURL = `https://circleci.com/api/v1.1/project/github/${ wpDesktopProject }/tree/${ wpDesktopBranchName }?circle-token=${ process.env.CIRCLECI_SECRET}`;

            const sha = event.payload.pull_request.head.sha;

            const buildParameters = {
                build_parameters: {
                    BRANCHNAME: wpDesktopBranchName,
                    sha: sha,
                    CALYPSO_HASH: sha,
                    pullRequestNum: pullRequestNum,
                    calypsoProject: calypsoProject
                }
            };

            // POST to CircleCI to initiate the build
            request.post( {
                headers: {'content-type': 'application/json', accept: 'application/json'},
                url: triggerBuildURL,
                body: JSON.stringify( buildParameters )
            } , function( error, response ) {
                if ( response.statusCode === 201 ) {
                    console.log( 'Tests have been kicked off - updating PR status now' );
                    // Post status to Github
                    const gitHubStatus = {
                        state: 'pending',
                        target_url: JSON.parse( response.body ).build_url,
                        context: prContext,
                        description: 'The wp-desktop tests are running against your PR'
                    };
                    request.post( {
                        headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
                        url: gitHubStatusURL + sha,
                        body: JSON.stringify( gitHubStatus )
                    }, function( responseError ) {
                        if ( responseError ) {
                            console.log( 'ERROR: ' + responseError  );
                        }
                        console.log( 'GitHub status updated' );
                    } );
                }
                else
                {
                    // Something went wrong - TODO: post message to the Pull Request about
                    console.log( 'Something went wrong with executing wp-desktop tests' );
                    console.log( 'ERROR::' + error );
                    console.log( 'RESPONSE::' + JSON.stringify( response ) );
                }
            } );
        } );
    }
});
