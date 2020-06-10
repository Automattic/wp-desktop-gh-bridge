const http = require ( 'http' );
const rp = require ( 'request-promise-native' );
const createHandler = require ( 'github-webhook-handler' );
const url = require( 'url' );
const { logger } = require( '@automattic/vip-go' );

const calypsoProject = process.env.CALYPSO_PROJECT || 'Automattic/wp-calypso';
const wpDesktopProject = process.env.DESKTOP_PROJECT || 'Automattic/wp-desktop';
const flowPatrolOnly = process.env.FLOW_PATROL_ONLY || 'false';

const flowPatrolUsernames = [ 'alisterscott', 'brbrr', 'bsessions85', 'hoverduck', 'rachelmcr', 'designsimply', 'astralbodies' ];
const triggerLabel = process.env.TRIGGER_LABEL || '[Status] Needs Review';

const gitHubReviewUsername = 'wp-desktop';

const gitHubStatusURL = `https://api.github.com/repos/${ calypsoProject }/statuses/`;
const gitHubDesktopBranchURL = `https://api.github.com/repos/${ wpDesktopProject }/branches/`;
const gitHubDesktopCreateFileURL = `https://api.github.com/repos/${wpDesktopProject}/contents/desktop-canary-bridge.patch`;
const gitHubReviewsURL = `https://api.github.com/repos/${ calypsoProject }/pulls`; // append :pull_number/reviews
const gitHubDesktopRefsURL = `https://api.github.com/repos/${ wpDesktopProject }/git/refs`;
const gitHubDesktopHeadsURL = `${ gitHubDesktopRefsURL }/heads/`;
const circleCIGetWorkflowURL = 'https://circleci.com/api/v2/pipeline/';
const circleCIWorkflowURL = 'https://circleci.com/workflow-run/';

const gitHubWebHookPath = '/ghwebhook';
const circleCIWebHookPath = '/circleciwebhook';
const healthCheckPath = '/cache-healthcheck';

// Helper to generate randomized content patches
function makeRandom(length) {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const prContext = 'ci/wp-desktop';

const log = logger( 'wp-desktop-gh-bridge:webhook' );
const handler = createHandler( { path: gitHubWebHookPath, secret: process.env.BRIDGE_SECRET } );
const request = rp.defaults( {
    simple:false,
    resolveWithFullResponse: true
} );

function sleep( ms ) {
    return new Promise( resolve=>{
        setTimeout( resolve, ms )
    } )
}

http.createServer( function (req, res) {
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
        log.debug( "Called from CircleCI" );
        let body = [];
        req.on( 'data', function( chunk ) {
            body.push( chunk );
        } ).on( 'end', function() {
            body = Buffer.concat( body ).toString();
            try {
                let payload = JSON.parse( body ).payload;
                if ( payload && payload.build_parameters && payload.build_parameters.sha && payload.build_parameters.calypsoProject === calypsoProject ) {
                    let status, desc;
                    const pullRequestNum = payload.build_parameters.pullRequestNum;
                    const pullRequestUsername = payload.build_parameters.pullRequestUsername;

                    if ( payload.outcome === 'success' ) {
                        status = 'success';
                        desc = 'Your PR passed the wp-desktop tests on CircleCI!';

                        let branch = payload.branch;
                        if( branch.indexOf( 'tests/' ) >= 0 ) {

                            // DELETE branch after successful test runs
                            request.delete( {
                                headers: {
                                    Authorization: 'token ' + process.env.GITHUB_SECRET,
                                    'User-Agent': 'wp-desktop-gh-bridge'
                                },
                                url: gitHubDesktopHeadsURL + branch
                            } )
                            .then( function( response ) {
                                if ( response.statusCode !== 204 ) {
                                    log.error( 'ERROR: Branch delete failed with error: ' + response.body );
                                } else {
                                    log.info( 'Branch ' + branch + ' deleted' );
                                }

                            } )
                            .catch( function( error ) {
                                log.error( 'ERROR: Branch delete failed with error: ' + error )
                            } )
                        }
                    } else if ( payload.outcome === 'failed' ) {
                        status = 'failure';
                        desc = `wp-desktop test status: ${ payload.status }`;
                    } else {
                        status = 'error';
                        desc = `wp-desktop test status: ${ payload.status }`;
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
                    } )
                    .then( function( response ) {
                        if ( response.statusCode !== 201 ) {
                            log.error( 'ERROR: ' + response.body );
                        } else {
                            log.debug( 'GitHub status updated' );

                            // if payload.status === 'failed', create a PR review
                            if ( payload.status === 'failed' ) {
                                // check for existing reviews
                                const getReviewsURL = gitHubReviewsURL + `/${ pullRequestNum }/reviews`;
                                request.get( {
                                    headers: { Authorization: 'token ' + process.env.GITHUB_REVIEW_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
                                    url: getReviewsURL
                                } )
                                .then( function( response ) {
                                    if ( response.statusCode !== 200 ) {
                                        log.error( `ERROR fetching reviews for PR: ${ pullRequestNum }`);
                                    } else {
                                        const reviews = JSON.parse( response.body );
                                        let alreadyReviewed = false;
                                        if ( reviews.length > 0 ) {
                                            for ( i = 0; i < reviews.length; i++ ) {
                                                const review = reviews[i];
                                                if ( review.user.login === gitHubReviewUsername && review.state !== 'DISMISSED' ) {
                                                    alreadyReviewed = true;
                                                    break;
                                                }
                                            }
                                        }

                                        // if there are no existing reviews, then create one
                                        if ( ! alreadyReviewed ) {
                                            const createReviewURL = gitHubReviewsURL + `/${ pullRequestNum }/reviews`;
                                            const msg = `WordPress Desktop CI Failure (ci/wp-desktop): ` +
                                                `@${ pullRequestUsername } please re-try this workflow ("Rerun Workflow from Failed") ` +
                                                `and/or review this PR for breaking changes. ` +
                                                `Please also ensure this branch is rebased off the latest Calypso master.`;
                                            const createReviewParameters = {
                                                body: msg,
                                                event: 'REQUEST_CHANGES',
                                            }
                                            request.post( {
                                                headers: { Authorization: 'token ' + process.env.GITHUB_REVIEW_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
                                                url: createReviewURL,
                                                body: JSON.stringify(createReviewParameters),
                                            })
                                            .then( function( response ) {
                                                if ( response.statusCode !== 200 ) {
                                                    log.error( `ERROR creating review for PR: ${ pullRequestNum }: ${ JSON.parse( response.body ) }`);
                                                }
                                            } );
                                        }
                                    }
                                } );
                            } else if ( payload.status === 'success' ) {
                                // if payload.status === 'success, delete existing review (if any)
                                const getReviewsURL = gitHubReviewsURL + `/${pullRequestNum}/reviews`;
                                request.get( {
                                    headers: { Authorization: 'token ' + process.env.GITHUB_REVIEW_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
                                    url: getReviewsURL
                                } )
                                .then( function( response ) {
                                    if ( response.statusCode !== 200 ) {
                                        log.error( `ERROR fetching reviews for PR: ${ pullRequestNum }: ${ JSON.parse( response.body ) }`);
                                    } else {
                                        const reviews = JSON.parse( response.body );
                                        if ( reviews.length > 0 ) {
                                            for ( i = 0; i < reviews.length; i++ ) {
                                                const review = reviews[i];
                                                if ( review.user.login === gitHubReviewUsername && review.state !== 'DISMISSED' ) {
                                                    const reviewId = review.id;

                                                    const dismissReviewURL = gitHubReviewsURL + `/${pullRequestNum}/reviews/${reviewId}/dismissals`;

                                                    request.put( {
                                                        headers: { Authorization: 'token ' + process.env.GITHUB_REVIEW_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
                                                        url: dismissReviewURL,
                                                        body: JSON.stringify( { message: 'ci/wp-desktop passing, closing review' } ),
                                                    } )
                                                    .then( function( response ) {
                                                        if ( response.statusCode !== 200 ) {
                                                            log.error( `Failed to dismiss review for PR: ${ pullRequestNum } with ID ${ reviewId }: ${ JSON.parse( response.body ) }`);
                                                        }
                                                    } );
                                                }
                                            }
                                        }
                                    }
                                } );
                            }
                        }
                    } )
                    .catch( function( error ) {
                        log.error( 'ERROR: ' + error )
                    } )
                }
            } catch ( e ) {
                log.info( 'Non-CircleCI packet received' );
            }
            res.statusCode = 200;
            res.end( 'ok' );
        } );
    } else {
        log.error( 'unknown location %s', fullUrl );
        res.statusCode = 404;
        res.end( 'no such location' );
    }
} ).listen( process.env.PORT || 7777 );

handler.on( 'error', function ( err ) {
    log.error( 'Error: %s', err.message );
} );

handler.on( 'pull_request', function ( event ) {
    const pullRequestNum = event.payload.pull_request.number;
    const pullRequestStatus = event.payload.pull_request.state;
    const loggedInUsername = event.payload.sender.login;
    const pullRequestHeadLabel = event.payload.pull_request.head.label;
    const repositoryName = event.payload.repository.full_name;
    const labelsArray = event.payload.pull_request.labels;
    let containsLabel;


    // Check if we should only run for certain users
    if ( flowPatrolOnly === 'true' && flowPatrolUsernames.indexOf( loggedInUsername ) === -1 ) {
        log.info( `Ignoring pull request '${ pullRequestNum }' as we're only running for certain users and '${ loggedInUsername }' is not in '${ flowPatrolUsernames }'` );
        return true;
    }

    // Make sure the PR is in the correct repository
    if ( repositoryName !== calypsoProject ) {
        log.info( `Ignoring pull request '${ pullRequestNum }' as the repository '${ repositoryName }' is not '${ calypsoProject }'` );
        return true;
    }

    // Make sure the PR is still open
    if ( pullRequestStatus !== 'open' ) {
        log.info( `Ignoring pull request '${ pullRequestNum }' as the status '${ pullRequestStatus }' is not 'open'` );
        return true;
    }

    // Ignore OSS requests - check for location of head to indicate forks
    if ( event.payload.pull_request.head.label.indexOf( 'Automattic:' ) !== 0 ) {
        log.info( `Ignoring pull request '${ pullRequestNum }' as this is from a fork: '${ pullRequestHeadLabel }'` );
        return true;
    }

    if ( event.payload.action === 'synchronize' ) {
        let filteredLabel = labelsArray.filter( label => label["name"] === triggerLabel );
        containsLabel = filteredLabel.length > 0;
    }

    if ( ( event.payload.action === 'labeled' && event.payload.label.name === triggerLabel ) || containsLabel ) {
        const wpCalypsoBranchName = event.payload.pull_request.head.ref;
        const desktopBranchName = 'tests/' + wpCalypsoBranchName;
        let wpDesktopBranchName;
        log.info( 'Executing wp-desktop tests for wp-calypso branch: \'' + wpCalypsoBranchName + '\'' );

        // Check if there's a matching branch in the wp-desktop repository
        request.get( {
            headers: {Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-desktop-gh-bridge'},
            url: gitHubDesktopBranchURL + desktopBranchName
        } )
        .then ( function( response ) {
            if ( response.statusCode === 200 ) {
                wpDesktopBranchName = desktopBranchName;
                // Get sha for develop branch
                return request.get( {
                    headers: {
                        Authorization: 'token ' + process.env.GITHUB_SECRET,
                        'User-Agent': 'wp-desktop-gh-bridge'
                    },
                    url: gitHubDesktopHeadsURL + 'develop'
                } )
                .then( function( response ) {
                     // Update branch if we can
                    const branch_parameters = {
                        sha: JSON.parse( response.body ).object.sha
                    };
                    return request.patch( {
                        headers: {
                            Authorization: 'token ' + process.env.GITHUB_SECRET,
                            'User-Agent': 'wp-desktop-gh-bridge'
                        },
                        url: gitHubDesktopHeadsURL + wpDesktopBranchName,
                        body: JSON.stringify( branch_parameters )
                    } )
                    .then( function( response ) {
                        if ( response.statusCode !== 200 ) {
                            log.error( 'ERROR: Unable to update existing branch. Failed with error:' + response.body );
                        }
                    } )
                } );
            } else {
                // Get sha for develop branch
                return request.get( {
                    headers: {
                        Authorization: 'token ' + process.env.GITHUB_SECRET,
                        'User-Agent': 'wp-desktop-gh-bridge'
                    },
                    url: gitHubDesktopHeadsURL + 'develop'
                } )
                .then( function( response ) {
                    // Create branch for tests to run from
                    if ( response.statusCode === 200 ) {
                        const branch_parameters = {
                            ref: 'refs/heads/' + desktopBranchName,
                            sha: JSON.parse( response.body ).object.sha
                        };
                        return request.post( {
                            headers: {
                                Authorization: 'token ' + process.env.GITHUB_SECRET,
                                'User-Agent': 'wp-desktop-gh-bridge'
                            },
                            url: gitHubDesktopRefsURL,
                            body: JSON.stringify( branch_parameters )
                        } )
                        .then( function( response ) {
                            if ( response.statusCode === 201 ) {
                                wpDesktopBranchName = desktopBranchName;

                                // Patch the newly-created branch so it has a different SHA from develop
                                // to minimize interference of CI status and cancellations between branches.
                                const desktopBranchPatchParameters = {
                                    message: `create canary patch for ${wpDesktopBranchName}`,
                                    branch: `${wpDesktopBranchName}`,
                                    content: Buffer.from(makeRandom(20)).toString('base64'), // patch needs to be base64-encoded
                                };

                                request.put({
                                    headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-desktop-gh-bridge' },
                                    url: gitHubDesktopCreateFileURL,
                                    body: JSON.stringify(desktopBranchPatchParameters),
                                })
                                    .then(function (response) {
                                        if (response.statusCode === 201) {
                                            const desktopBranchSha = JSON.parse(response.body).commit.sha;
                                            log.info( `Branch '${wpDesktopBranchName}' patched with SHA: ${desktopBranchSha}`);
                                        } else {
                                            log.error( 'ERROR: Unable to patch new branch. Failed with error: ' + response.body );
                                        }
                                    })
                            } else {
                                log.error( 'ERROR: Unable to create new branch. Failed with error:' + response.body );
                            }
                        } )
                    } else {
                        log.error( 'ERROR: Unable to get details for "develop" branch. Failed with error:' + response.body );
                        wpDesktopBranchName = 'develop';
                    }
                } )
            }
        } )
        .then ( async function () {

            const triggerBuildURL = `https://circleci.com/api/v2/project/github/${ wpDesktopProject }/pipeline`;

            const sha = event.payload.pull_request.head.sha;
            const prUserName = event.payload.pull_request.user.login;
            const prNum = event.payload.pull_request.number;

            const buildParameters = {
                branch: wpDesktopBranchName,
                parameters: {
                    sha: sha,
                    CALYPSO_HASH: sha,
                    calypsoProject: calypsoProject,
                    isCalypsoCanaryRun: true,
                    pullRequestUserName: prUserName,
                    pullRequestNum: prNum.toString()
                }
            };
            // POST to CircleCI to initiate the build
            await sleep(5000);
            return request.post( {
                auth: {
                    username: `${ process.env.CIRCLECI_SECRET }`
                },
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                url: triggerBuildURL,
                body: JSON.stringify( buildParameters )
            } ).then( async function( response ) {
                if (response.statusCode === 201) {
                    let workflowID;
                    let getWorkflowURL = circleCIGetWorkflowURL + JSON.parse(response.body).id + `/workflow`;
                    let workflowFound = false;
                    let i = 0;

                    // Get workflow ID and update GH when we have one
                    while (i < 60 && !workflowFound) {
                        await sleep(1000);
                        await request.get({
                            auth: {
                                username: `${ process.env.CIRCLECI_SECRET }`
                            },
                            headers: {'content-type': 'application/json', accept: 'application/json'},
                            url: getWorkflowURL,
                        }, async function (responseError, responseCI) {
                            if (responseError) {
                                log.error('Error when getting workflow ID');
                                log.error('ERROR: ' + responseError);
                            }
                            //Make sure a workflow id was returned
                            let workflows = JSON.parse(responseCI.body).items;
                            if (workflows.length === 0) {
                                return;
                            }
                            workflowID = workflows[0].id;
                            workflowFound = true;
                            // Post status to Github
                            const gitHubStatus = {
                                state: 'pending',
                                target_url: circleCIWorkflowURL + workflowID,
                                context: prContext,
                                description: 'The wp-desktop tests are running against your PR'
                            };
                            return request.post({
                                headers: {
                                    Authorization: 'token ' + process.env.GITHUB_SECRET,
                                    'User-Agent': 'wp-desktop-gh-bridge'
                                },
                                url: gitHubStatusURL + sha,
                                body: JSON.stringify(gitHubStatus)
                            }).then(function (response) {
                                if (response.statusCode !== 201) {
                                    log.error('ERROR: ' + response.body);
                                }
                                log.debug('GitHub status updated');
                            });
                        });
                        i++;
                    }
                }
            }  )
        } )
    }
});
