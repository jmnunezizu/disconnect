'use strict';

const https = require('https'),
    zlib = require('zlib'),
    url = require('url'),
    pkg = require('../package.json'),
    error = require('./error.js'),
    database = require('./database.js'),
    marketplace = require('./marketplace.js'),
    user = require('./user.js'),
    Util = require('./util.js'),
    Queue = require('./queue.js'),
    DiscogsOAuth = require('./oauth.js');

/**
 * Default configuration
 */
const defaultConfig = {
    host: 'api.discogs.com',
    port: 443,
    userAgent: 'DisConnectClient/' + pkg.version + ' +' + pkg.homepage,
    apiVersion: 'v2',
    outputFormat: 'discogs', // Possible values: 'discogs' / 'plaintext' / 'html'
    requestLimit: 240, // Maximum number of requests to the Discogs API per interval
    requestLimitInterval: 60000, // Request interval in milliseconds
    requestLimitQueueSize: 20 // Request queue size, use wisely
};

/**
 * Store the client instance config privately in a WeakMap
 * @type {WeakMap}
 */
const configStore = new WeakMap();

/**
 * Store the client instance authentication privately in a WeakMap
 * @type {WeakMap}
 */
const authStore = new WeakMap();

/**
 * The request queue, shared by all DiscogsClient instances
 * @type {Queue}
 */
const queue = new Queue({
    maxStack: defaultConfig.requestLimitQueueSize,
    maxCalls: defaultConfig.requestLimit,
    interval: defaultConfig.requestLimitInterval
});

/**
 * DiscogsClient class definition
 */
class DiscogsClient {
    
    /**
     * Object constructor
     * @param {string} [userAgent] - The name of the user agent to use to make API calls
     * @param {object} [authData] - Optional authorization data object
     * @return {DiscogsClient}
     */
    constructor(userAgent, authData) {
        // Set the default configuration and authorization data
        configStore.set(this, Util.merge({}, defaultConfig));
        authStore.set(this, {method: 'none', level: 0});
        // Set the custom User Agent when provided
        if (typeof userAgent === 'string') {
            configStore.get(this).userAgent = userAgent;
        }
        // No userAgent provided, but instead we have an accessObject
        if ((arguments.length === 1) && (typeof userAgent === 'object')) {
            authData = userAgent;
        }
        // Set auth data when provided
        if (authData && (typeof authData === 'object')) {
            if (!authData.hasOwnProperty('method')) {
                authData.method = 'discogs';
            }
            if (!authData.hasOwnProperty('level')) {
                if (authData.userToken) {
                    authData.level = 2;
                } else if (authData.consumerKey && authData.consumerSecret) {
                    authData.level = 1;
                }
            }
            Util.merge(authStore.get(this), authData);
        }
    }

    /**
     * Override the default configuration
     * @param {object} customConfig - Custom configuration object for Browserify/CORS/Proxy use cases
     * @return {DiscogsClient}
     */
    setConfig(customConfig) {
        if (customConfig && (typeof customConfig === 'object')) {
            let config = configStore.get(this);
            Util.merge(config, customConfig);
            queue.setConfig({
                maxStack: config.requestLimitQueueSize,
                maxCalls: config.requestLimit,
                interval: config.requestLimitInterval
            });
        }
        return this;
    };

    /**
     * Return whether the client is authenticated for the optionally given access level
     * @param {number} [level] - Optional authentication level
     * @return {boolean}
     */
    authenticated(level) {
        level = level || 0;
        return ((authStore.get(this).level > 0) && (authStore.get(this).level >= level));
    };

    /**
     * Test authentication by getting the identity resource for the authenticated user
     * @param {function} callback - Callback function receiving the data
     * @return {DiscogsClient|Promise}
     */
    getIdentity(callback) {
        return this.get({url: '/oauth/identity', authLevel: 2}, callback);
    };

    /**
     * Get info about the Discogs API and this client
     * @param {function} callback - Callback function receiving the data
     */
    about(callback) {
        let clientInfo = {
            version: pkg.version,
            userAgent: configStore.get(this).userAgent,
            authMethod: authStore.get(this).method,
            authLevel: authStore.get(this).level
        };
        if (typeof callback === 'function') {
            return this.get('', (err, data) => {
                data && (data.disconnect = clientInfo);
                callback(err, data);
            });
        }
        return this.get('').then((data) => {
            data && (data.disconnect = clientInfo);
            return data;
        });
    };

    /**
     * Perform a GET request against the Discogs API
     * @param {(object|string)} options - Request options object or an url
     * @param {function} [callback] - Callback function receiving the data
     * @return {DiscogsClient|Promise}
     */
    get(options, callback) {
        if (typeof options === 'string') {
            options = {url: options};
        }
        return request.call(this, options, callback);
    };

    /**
     * Perform a POST request against the Discogs API
     * @param {(object|string)} options - Request options object or an url
     * @param {object} data - POST data
     * @param {function} [callback] - Callback function receiving the data
     * @return {DiscogsClient|Promise}
     */
    post(options, data, callback) {
        if (typeof options === 'string') {
            options = {url: options};
        }
        return request.call(this, Util.merge(options, {method: 'POST', data: data}), callback);
    };

    /**
     * Perform a PUT request against the Discogs API
     * @param {(object|string)} options - Request options object or an url
     * @param {object} data - PUT data
     * @param {function} [callback] - Callback function receiving the data
     * @return {DiscogsClient|Promise}
     */
    put(options, data, callback) {
        if (typeof options === 'string') {
            options = {url: options};
        }
        return request.call(this, Util.merge(options, {method: 'PUT', data: data}), callback);
    };

    /**
     * Perform a DELETE request against the Discogs API
     * @param {(object|string)} options - Request options object or an url
     * @param {function} [callback] - Callback function receiving the data
     * @return {DiscogsClient|Promise}
     */
    delete(options, callback) {
        if (typeof options === 'string') {
            options = {url: options};
        }
        return request.call(this, Util.merge(options, {method: 'DELETE'}), callback);
    };

    /**
     * Get an instance of the Discogs OAuth class
     * @return {DiscogsOAuth}
     */
    oauth() {
        return new DiscogsOAuth(auth.get(this));
    };

    /**
     * Expose the database functions and pass the current instance
     * @return {object}
     */
    database() {
        return database(this);
    };

    /**
     * Expose the marketplace functions and pass the current instance
     * @return {object}
     */
    marketplace() {
        return marketplace(this);
    };

    /**
     * Expose the user functions and pass the current instance
     * @return {object}
     */
    user() {
        return user(this);
    };
}

/**
 * Expose the DiscogsClient class
 */
module.exports = DiscogsClient;

/**
 * Send a request and parse text response to JSON
 * @param {object} options - Request options
 * {
 *     url: '', // May be a relative path when accessing the Discogs API
 *     method: '', // Defaults to GET
 *     data: {} // POST/PUT data as an object
 * }
 * @param {function} [callback] - Callback function receiving the data
 * @return {DiscogsClient|Promise}
 */
function request(options, callback) {
    let doRequest = () => {
        rawRequest.call(this, options, (err, data, rateLimit) => {
            if (data && options.json && (data.indexOf('<!') !== 0)) {
                data = JSON.parse(data);
            }
            callback(err, data, rateLimit);
        });
    };
    let prepareRequest = () => {
        // Check whether authentication is required
        if (!options.authLevel || this.authenticated(options.authLevel)) {
            if (options.queue) { // Add API request to the execution queue
                queue.add((err) => {
                    if (!err) {
                        doRequest(callback);
                    } else { // Can't add to the queue because it's full
                        callback(err);
                    }
                });
            } else { // Don't queue, just do the request
                doRequest(callback);
            }
        } else {
            callback(new error.AuthError());
        }
    };

    // By default, queue requests
    if (!options.hasOwnProperty('queue')) {
        options.queue = true;
    }
    // By default, expect responses to be JSON
    if (!options.hasOwnProperty('json')) {
        options.json = true;
    }

    if (typeof callback === 'function') {
        prepareRequest();
        return this;
    }
    // No callback provided? Return a Promise
    return new Promise((resolve, reject) => {
        callback = (err, data) => {
            (err && reject(err)) || resolve(data);
        };
        prepareRequest();
    });
};

/**
 * Send a raw request
 * @param {object} options - Request options 
 * {
 *     url: '', // May be a relative path when accessing the discogs API
 *     method: '', // Defaults to GET
 *     data: {} // POST/PUT data as an object
 * }
 * @param {function} callback - Callback function receiving the data
 * @return {DiscogsClient}
 */
function rawRequest(options, callback) {
    let data = options.data || null,
        method = options.method || 'GET',
        urlParts = url.parse(options.url),
        encoding = options.encoding || 'utf8',
        config = configStore.get(this),
        auth = authStore.get(this);

    // Build request headers
    let headers = {
        'User-Agent': config.userAgent,
        'Accept': 'application/json,application/vnd.discogs.' + config.apiVersion + '.' + config.outputFormat + '+json,application/octet-stream',
        'Accept-Encoding': 'gzip,deflate',
        'Host': config.host,
        'Connection': 'close',
        'Content-Length': 0
    };

    // Add content headers for POST/PUT requests that contain data
    if (data) {
        if (typeof data === 'object') { // Convert data to a JSON string when data is an object/array
            data = JSON.stringify(data);
        }
        headers['Content-Type'] = 'application/json'; // Discogs accepts data in JSON format
        headers['Content-Length'] = Buffer.byteLength(data, 'utf8');
    }

    // Add Authorization header when authenticated (or in the process of authenticating)
    if ((auth.consumerKey || auth.userToken)) {
        let authHeader = '';
        if (auth.method === 'oauth') {
            let fullUrl = (urlParts.protocol && urlParts.host) ? urlParts.href : 'https://' + config.host + urlParts.path;
            authHeader = this.oauth().toHeader(method, fullUrl);
        } else if (auth.method === 'discogs') {
            authHeader = 'Discogs';
            if (auth.userToken) {
                authHeader += ' token=' + auth.userToken;
            } else if (auth.consumerKey) {
                authHeader += ' key=' + auth.consumerKey + ', secret=' + auth.consumerSecret;
            }
        }
        headers['Authorization'] = authHeader;
    }

    // Set the HTTPS request options
    let requestOptions = {
        host: urlParts.host || config.host,
        port: urlParts.port || config.port,
        path: urlParts.path,
        method: method,
        headers: headers
    };

    // Build the HTTPS request	
    let req = https.request(requestOptions, (res) => {
        let data = '',
            rateLimit = null,
            add = (chunk) => { data += chunk.toString(); };

        // Pass the data to the callback and pass an error on unsuccessful HTTP status
        let passData = () => {
            let err = null, 
                status = parseInt(res.statusCode, 10);
            if (status > 399) { // Unsuccessful HTTP status? Then pass an error to the callback
                let match = data.match(/^\{"message": "(.+)"\}/i);
                err = new error.DiscogsError(status, ((match && match[1]) ? match[1] : null));
            }
            callback(err, data, rateLimit);
        };

        // Find and add rate limiting when present
        if (res.headers['x-ratelimit-type']) {
            rateLimit = {
                type: res.headers['x-ratelimit-type'],
                limit: res.headers['x-ratelimit-limit'],
                reset: res.headers['x-ratelimit-reset'],
                remaining: res.headers['x-ratelimit-remaining']
            };
        }

        // Get the response content and pass it to the callback
        switch (res.headers['content-encoding']) {
            case 'gzip':
                let gunzip = zlib.createGunzip().on('data', add).on('end', passData);
                res.pipe(gunzip);
                break;
            case 'deflate':
                let inflate = zlib.createInflate().on('data', add).on('end', passData);
                res.pipe(inflate);
                break;
            default:
                // Set encoding when provided
                res.setEncoding(encoding);
                res.on('data', add).on('end', passData);
        }
    }).on('error', (err) => {
        callback(err);
    });

    // When present, write the data to the request
    if (data) {
        req.write(data);
    }

    req.end();
    return this;
};