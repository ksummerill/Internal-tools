const lambdaCfn = require('@mapbox/lambda-cfn');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const decrypt = require('decrypt-kms-env');
const querystring = require('querystring');
const moment = require('moment');
const request = require('request');
const gt = require('./lib/generate-table');
const queue = require('d3-queue').queue;

// checksig is a function to make sure that Github hash is what we expect. This is for security
module.exports.lambda = function(event, context, cb) {
    try {
        if (!checksig(event.headers, event.body, process.env.WEBHOOK_SECRET)) throw new Error('Not Authorized!');

        event.body = JSON.parse(event.body);
    } catch (err) {
        console.error(err);
        return cb(null, {
            statusCode: 400,
            headers: { },
            body: 'parse: ' + err.message
        });
    }

    try {
        if (!event.body.action || event.body.action !== 'labeled') throw new Error('Event not relevant - not labeled');
        if (!event.body.issue || !event.body.issue.labels || !Array.isArray(event.body.issue.labels)) throw new Error('Event is missing body.issue or body.issues.labels');
        if (!event.body.issue.labels.some((label) => { if (label.name === 'calc-usage') return true; })) throw new Error('Event is not relevant - no calc-usage label');

    } catch (err) {
        console.error(err);
        return cb(null, {
            statusCode: 200,
            headers: {},
            body: `validate: ${err.message}`
        });
    }

// cloud formation stack creation - decrypts env variables
decrypt(process.env, (err) => {
    if (err) {
        console.error(err);
        return cb(null, { statusCode: 500, headers: { }, body: `decrypt: ${err.message}` });
    }

    const key = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');

    githubToken(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_INSTALLATION_ID, key, (err, token) => {
        if (err) {
            console.error(err);
            return cb(null, { statusCode: 500, headers: { }, body: `token: ${err.message}` });
        }

        githubLabel(event, token, (err) => {
            if (err) {
                console.error(err);
                return cb(null, { statusCode: 500, headers: { }, body: `gh retrieve: ${err.message}` });
            }

            githubRetrieve(event, token, (err, issue) => {
                if (err) {
                    console.error(err);
                    return cb(null, { statusCode: 500, headers: { }, body: `gh retrieve: ${err.message}` });
                }
                // looking for account name of customer
                let account = issue.body.match(/impersonate=([a-z0-9]+)/);
                if (!account) return githubError(event, token, `Could not parse Mapbox Account Name`);

                account = account[1];

                statisticsFetch((formattedLines) => {
                    githubDisplay(event, token, formattedLines, {
                        account: account
                    }, (err, res) => {
                        if (err) {
                            console.error(err);
                            return cb(null, { statusCode: 500, headers: { }, body: `gh display: ${err.message}` });
                        }

                        return cb(null, { statusCode: 200, headers: { }, body: 'Yep' });
                    });
                })

            });
        });
    });
});
};

// getting the text inside the GH issue (top post)
const githubRetrieve = (event, token, cb) => {
    request({
        url: `https://api.github.com/repos/${event.body.repository.full_name}/issues/${event.body.issue.number}`,
        json: true,
        method: 'GET',
        headers: {
            'Content-type': 'application/json',
            'User-Agent': 'github.com/mapbox/scrooge',
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.machine-man-preview+json'
        }
    }, (err, res, body) => {
        if (err) return cb(err);
        if (res.statusCode !== 200) return cb(new Error(body));

        return cb(null, body);
    });
};

// remove the label so we can try again. Turning the label into a button
const githubLabel = (event, token, cb) => {
    //Remove Label From Issue
    request({
        url: `https://api.github.com/repos/${event.body.repository.full_name}/issues/${event.body.issue.number}/labels/calc-usage`,
        method: 'DELETE',
        headers: {
            'Content-type': 'application/json',
            'User-Agent': 'github.com/mapbox/scrooge',
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.machine-man-preview+json'
        }
    }, (err, res, body) => {
        if (err) return cb(err);
        if (res.statusCode !== 200) return cb(new Error(body));

        return cb()
    });
};

const statisticsFetch = (cb) => {

    var q = queue(10);
    var encoded = Buffer.from(process.env.MODE_TOKEN).toString('base64');


    // Master request function with url and headers

    function formRequestHeaders(url) {
      return {
        url: url,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': "Basic " + encoded,

      },
      gzip: true

  };

}

    var baseUrl = 'https://modeanalytics.com/api/mapbox/reports/056affb7f09e/runs/';

    request(formRequestHeaders(baseUrl), function(err, response, body) {
      if (response.statusCode === 200) {
        queryRunUrl(JSON.parse(body));
        console.log("Success!");
    } else {
        console.error("error",err);
    }
});

    function queryRunUrl(body) {
      var runToken = body._embedded.report_runs[0].token;
      var qrUrl = baseUrl + runToken + '/results/content.json';
      console.log("qrUrl:",qrUrl);
      queryContent(qrUrl);
  };

    // function to grab data and send it to another function to format it

    function queryContent(url) {
      var usageInfo = request(formRequestHeaders(url), (err, body) => {
          console.log("This is the url:",url);
          if (body.statusCode === 200) {
              console.log("Second Success");
              formatData(JSON.parse(body.body));
          } else {
              console.error("error",err);
          }

    // function to format the data

    function formatData(allCustomerData){
      for (var i = 0; i < allCustomerData.length; i++) {

          var data = allCustomerData[i];
          var lines = [];
          var today = new Date();
          var account = data.product_name;
          var columns = (['Products', 'Purchased', 'Used', '%']);
          var rowOne = (["Map Views", data.mapviews_purchased, data.mapviews_used, Math.round(data.percent_map_views_used)]);
          var rowTwo = (["Temporary Geocodes", data.temp_geocodes_purchased, data.temp_geocodes_used, Math.round(data.percent_temp_geocodes_used)]);
          var rowThree = (["Permanent Geocodes", data.perm_geocodes_purchased, data.perm_geocode_used, Math.round(data.percent_perm_geocodes_used)]);
          var rowFour = (["Directions", data.directions_purchased, data.directions_used, Math.round(data.percent_directions_used)]);

            // always have these elements in the chart
            lines.push('\n' + "### Opportunity: " + account);
            lines.push(`#### Today's Date: ${today.toDateString()}\n`);
            lines.push(joinColumns(['Products', 'Purchased', 'Used', '%']));
            lines.push('|---|---|---|---|');

            // if/else statements handle null and 0 values for products purchased and used
            if (data.mapviews_purchased === null && data.mapviews_used === 0) {

                lines.push(joinColumns(["Temporary Geocodes", data.temp_geocodes_purchased, data.temp_geocodes_used, Math.round(data.percent_temp_geocodes_used) + '%']));
                lines.push(joinColumns(["Permanent Geocodes", data.perm_geocodes_purchased, data.perm_geocode_used, Math.round(data.percent_perm_geocodes_used) + '%']));
                lines.push(joinColumns(["Directions", data.directions_purchased, data.directions_used, Math.round(data.percent_directions_used) + '%']));
            } else if (data.temp_geocodes_purchased === null && data.temp_geocodes_used === 0) {

                lines.push(joinColumns(["Map Views", data.mapviews_purchased, data.mapviews_used, Math.round(data.percent_map_views_used) + '%']));
                lines.push(joinColumns(["Permanent Geocodes", data.perm_geocodes_purchased, data.perm_geocode_used, Math.round(data.percent_perm_geocodes_used) + '%']));
                lines.push(joinColumns(["Directions", data.directions_purchased, data.directions_used, Math.round(data.percent_directions_used) + '%']));
            } else if (data.perm_geocodes_purchased === null && data.perm_geocode_used === 0) {

                lines.push(joinColumns(["Map Views", data.mapviews_purchased, data.mapviews_used, Math.round(data.percent_map_views_used) + '%']));
                lines.push(joinColumns(["Temporary Geocodes", data.temp_geocodes_purchased, data.temp_geocodes_used, Math.round(data.percent_temp_geocodes_used) + '%']));
                lines.push(joinColumns(["Directions", data.directions_purchased, data.directions_used, Math.round(data.percent_directions_used) + '%']));
            } else if (data.directions_purchased === null && data.directions_used === 0) {

                lines.push(joinColumns(["Map Views", data.mapviews_purchased, data.mapviews_used, Math.round(data.percent_map_views_used) + '%']));
                lines.push(joinColumns(["Temporary Geocodes", data.temp_geocodes_purchased, data.temp_geocodes_used, Math.round(data.percent_temp_geocodes_used) + '%']));
                lines.push(joinColumns(["Permanent Geocodes", data.perm_geocodes_purchased, data.perm_geocode_used, Math.round(data.percent_perm_geocodes_used) + '%']));

            } else {
                lines.push(joinColumns(["Map Views", data.mapviews_purchased, data.mapviews_used, Math.round(data.percent_map_views_used) + '%']));
                lines.push(joinColumns(["Temporary Geocodes", data.temp_geocodes_purchased, data.temp_geocodes_used, Math.round(data.percent_temp_geocodes_used) + '%']));
                lines.push(joinColumns(["Permanent Geocodes", data.perm_geocodes_purchased, data.perm_geocode_used, Math.round(data.percent_perm_geocodes_used) + '%']));
                lines.push(joinColumns(["Directions", data.directions_purchased, data.directions_used, Math.round(data.percent_directions_used) + '%']));
            }

            cb(lines.join('\n'));
        }
    }

    // function to join the columns and put a | in between

    function joinColumns(cols) {
      return `|${cols.join(' | ')}|`
  }

});

};


}

// request to Github to display table.
const githubDisplay = (event, token, formattedLines, meta, cb) => {
    request({
        url: `https://api.github.com/repos/${event.body.repository.full_name}/issues/${event.body.issue.number}/comments`,
        method: 'POST',
        body: JSON.stringify({ "body": formattedLines }),
        headers: {
            'Content-type': 'application/json',
            'User-Agent': 'github.com/mapbox/scrooge',
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.machine-man-preview+json'
        }
    }, (err, res, body) => {
        if (err) return cb(err);
        if (res.statusCode !== 200) return cb(new Error(body));

        return cb();
    });
};

const githubError = (event, token, error, cb) => {
    request({
        url: `https://api.github.com/repos/${event.body.repository.full_name}/issues/${event.body.issue.number}/comments`,
        method: 'POST',
        body: JSON.stringify({ body: `
            Uh Oh! I have a problem!

            ${error}
            `}),
        headers: {
            'Content-type': 'application/json',
            'User-Agent': 'github.com/mapbox/scrooge',
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.machine-man-preview+json'
        }
    }, (err, res, body) => {
        if (cb) {
            if (err) return cb(err);
            if (res.statusCode !== 200) return cb(new Error(body));
        } else {
            if (err) throw err;
            if (res.statusCode !== 200) return new Error(body);
        }
    });
}

const checksig = (headers, body, secret) => {
    return headers['X-Hub-Signature'] === `sha1=${crypto.createHmac('sha1', secret).update(new Buffer(body)).digest('hex')}`;
};

/**
 * Creates a JSON web token with the private key and authenticates
 * as an installation, receives access token in response.
 * Github apps authentication process described in
 * [documentation](https://github.com/mapbox/security/blob/d163a34dd92771837e6044e68af5f9f4b2ec9d21/docs/github-app.md)
 * @param {number} appId - needed to generate JSON web token
 * @param {number} installationId - needed to work with the Github API
 * @param {string} privateKey - RSA private key, needed to generate JSON web token
 */
 const githubToken = (appId, installationId, privateKey, cb) => {
    try {
        const token = jwt.sign({
            iss: appId,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) +  (10 * 60)
        }, privateKey, { algorithm: 'RS256' });

        const headers = {
            'User-Agent': 'github.com/mapbox/scrooge',
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.machine-man-preview+json'
        };

        request({
            url: 'https://api.github.com/app',
            method: 'GET',
            json: true,
            headers: headers,
        }, (err, res) => {
            if (err) return cb(err);

            request({
                url: `https://api.github.com/installations/${installationId}/access_tokens`,
                method: 'POST',
                json: true,
                headers: headers
            }, (err, res) => {
                if (err) return cb(err);

                return cb(null, res.body.token);
            });
        });
    } catch (err) {
        return cb(err);
    }
};
