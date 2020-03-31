var url         = require('url')
var MemoryCache = require('./memory-cache')
var pkg         = require('../package.json')

var t           = {
  ms:           1,
  second:       1000,
  minute:       60000,
  hour:         3600000,
  day:          3600000 * 24,
  week:         3600000 * 24 * 7,
  month:        3600000 * 24 * 30,
}

var instances = []

var matches = function(a) {
  return function(b) { return a === b }
}

var doesntMatch = function(a) {
  return function(b) { return !matches(a)(b) }
}

var logDuration = function(d, prefix) {
  var str = (d > 1000) ? ((d/1000).toFixed(2) + 'sec') : (d + 'ms')
  return '\x1b[33m- ' + (prefix ? prefix + ' ' : '') + str + '\x1b[0m'
}

function ApiCache() {
  var memCache = new MemoryCache

  var globalOptions = {
    debug:              false,
    defaultDuration:    3600000,
    enabled:            true,
    appendKey:          [],
    jsonp:              false,
    redisClient:        false,
    headerBlacklist:    [],
    statusCodes: {
      include: [],
      exclude: [],
    },
    events: {
      'expire': undefined
    },
    headers: {
      // 'cache-control':  'no-cache' // example of header overwrite
    },
    trackPerformance: false
  }

  var middlewareOptions = []
  var instance = this
  var index = null
  var timers = {}
  var performanceArray = [] // for tracking cache hit rate

  instances.push(this)
  this.id = instances.length

  function debug(a,b,c,d) {
    var arr = (['\x1b[36m[koa-apicache]\x1b[0m', a,b,c,d]).filter(function(arg) { return arg !== undefined })
    var debugEnv = process.env.DEBUG && process.env.DEBUG.split(',').indexOf('apicache') !== -1

    return (globalOptions.debug || debugEnv) && console.log.apply(null, arr)
  }

  function shouldCacheResponse(ctx, toggle) {
    var opt = globalOptions
    var codes = opt.statusCodes

    if (!ctx) return false

    if (toggle && !toggle(ctx)) {
      return false
    }

    if (codes.exclude && codes.exclude.length && codes.exclude.indexOf(ctx.status) !== -1) return false
    if (codes.include && codes.include.length && codes.include.indexOf(ctx.status) === -1) return false

    return true
  }

  function addIndexEntries(key, ctx) {
    var groupName = ctx.apicacheGroup

    if (groupName) {
      debug('group detected "' + groupName + '"')
      var group = (index.groups[groupName] = index.groups[groupName] || [])
      group.unshift(key)
    }

    index.all.unshift(key)
  }

  function filterBlacklistedHeaders(headers) {
    return Object.keys(headers).filter(function (key) {
      return globalOptions.headerBlacklist.indexOf(key) === -1
    }).reduce(function (acc, header) {
        acc[header] = headers[header]
        return acc
    }, {})
  }

  function createCacheObject(status, headers, data) {
    return {
      status: status,
      headers: filterBlacklistedHeaders(headers),
      data: data,
      timestamp: new Date().getTime()/1000 // seconds since epoch.  This is used to properly decrement max-age headers in cached responses.
    }
  }

  function cacheResponse(key, value, duration) {
    var redis = globalOptions.redisClient
    var expireCallback = globalOptions.events.expire

    if (redis) {
      try {
        debug('redishset: key ==>', key)
        redis.hset(key, "response", JSON.stringify(value))
        redis.hset(key, "duration", duration)
        redis.expire(key, duration/1000, expireCallback || function() {})
      } catch (err) {
        debug('[apicache] error in redis.hset()')
      }
    } else {
      memCache.add(key, value, duration, expireCallback)
    }

    // add automatic cache clearing from duration, includes max limit on setTimeout
    timers[key] = setTimeout(function() { instance.clear(key, true) }, Math.min(duration, 2147483647))
  }

  async function makeResponseCacheable(ctx, next, key, duration, strDuration, toggle) {

    debug('init cache because no cache hit!')
    await next()

    Object.keys(globalOptions.headers).forEach(function(name) {
      ctx.set(name, globalOptions.headers[name])
    })

    if (!globalOptions.headers['cache-control']) {
      if(shouldCacheResponse(ctx, toggle)) {
        ctx.set('cache-control', 'max-age=' + (duration / 1000).toFixed(0))
      } else {
        ctx.set('cache-control', 'no-cache, no-store, must-revalidate')
      }
    }

    if (shouldCacheResponse(ctx, toggle)) {
      addIndexEntries(key, ctx)
      var headers = ctx.response.headers
      var cacheObject = createCacheObject(ctx.status, headers, ctx.body)
      cacheResponse(key, cacheObject, duration)

      // display log entry
      var elapsed = new Date() - ctx.apicacheTimer
      debug('adding cache entry for "' + key + '" @ ' + strDuration, logDuration(elapsed))
      debug('cacheObject: ', cacheObject)
    }
  }

  async function sendCachedResponse(ctx, cacheObject, toggle, next, duration) {
    debug('sendCachedResponse: has cache, get memory cache by key.')

    if (toggle && !toggle(ctx)) {
      return await next()
    }

    var headers = ctx.headers

    Object.assign(headers, filterBlacklistedHeaders(cacheObject.headers || {}), {
      // set properly-decremented max-age header.  This ensures that max-age is in sync with the cache expiration.
      'cache-control': 'max-age=' + Math.max(0,((duration/1000 - (new Date().getTime()/1000 - cacheObject.timestamp))).toFixed(0))
    })

    // only embed apicache headers when not in production environment
    if (process.env.NODE_ENV !== 'production') {
      Object.assign(headers, {
        'apicache-store': globalOptions.redisClient ? 'redis' : 'memory',
        'apicache-version': pkg.version
      })
    }

    // test Etag against If-None-Match for 304
    var cachedEtag = cacheObject.headers.etag
    var requestEtag = ctx.headers['if-none-match']

    if (requestEtag && cachedEtag === requestEtag) {
      ctx.set(headers)
      ctx.status = 304
      return
    }

    debug('sendCachedResponse: send memory cache data.')

    ctx.set(headers)
    ctx.status = cacheObject.status || 200
    ctx.body = cacheObject.data

    return
  }

  function syncOptions() {
    for (var i in middlewareOptions) {
      Object.assign(middlewareOptions[i].options, globalOptions, middlewareOptions[i].localOptions)
    }
  }

  this.clear = function(target, isAutomatic) {
    var group = index.groups[target]
    var redis = globalOptions.redisClient

    if (group) {
      debug('clearing group "' + target + '"')

      group.forEach(function(key) {
        debug('clearing cached entry for "' + key + '"')
        clearTimeout(timers[key])
        delete timers[key]
        if (!globalOptions.redisClient) {
          memCache.delete(key)
        } else {
          try {
            redis.del(key)
          } catch(err) {
            console.log('[apicache] error in redis.del("' + key + '")')
          }
        }
        index.all = index.all.filter(doesntMatch(key))
      })

      delete index.groups[target]
    } else if (target) {
      debug('clearing ' + (isAutomatic ? 'expired' : 'cached') + ' entry for "' + target + '"')
      clearTimeout(timers[target])
      delete timers[target]
      // clear actual cached entry
      if (!redis) {
        memCache.delete(target)
      } else {
        try {
          redis.del(target)
        } catch(err) {
          console.log('[apicache] error in redis.del("' + target + '")')
        }
      }

      // remove from global index
      index.all = index.all.filter(doesntMatch(target))

      // remove target from each group that it may exist in
      Object.keys(index.groups).forEach(function(groupName) {
        index.groups[groupName] = index.groups[groupName].filter(doesntMatch(target))

        // delete group if now empty
        if (!index.groups[groupName].length) {
          delete index.groups[groupName]
        }
      })
    } else {
      debug('clearing entire index')

      if (!redis) {
        memCache.clear()
      } else {
        // clear redis keys one by one from internal index to prevent clearing non-apicache entries
        index.all.forEach(function(key) {
          clearTimeout(timers[key])
          delete timers[key]
          try {
            redis.del(key)
          } catch(err) {
            console.log('[apicache] error in redis.del("' + key + '")')
          }
        })
      }
      this.resetIndex()
    }

    return this.getIndex()
  }

  function parseDuration(duration, defaultDuration) {
    if (typeof duration === 'number') return duration

    if (typeof duration === 'string') {
      var split = duration.match(/^([\d\.,]+)\s?(\w+)$/)

      if (split.length === 3) {
        var len = parseFloat(split[1])
        var unit = split[2].replace(/s$/i,'').toLowerCase()
        if (unit === 'm') {
          unit = 'ms'
        }

        return (len || 1) * (t[unit] || 0)
      }
    }

    return defaultDuration
  }

  this.getDuration = function(duration) {
    return parseDuration(duration, globalOptions.defaultDuration)
  }

  /**
   * Return cache performance statistics (hit rate).  Suitable for putting into a route:
   * <code>
   * app.get('/api/cache/performance', (req, res) => {
   *    res.json(apicache.getPerformance())
   * })
   * </code>
   */
  this.getPerformance = function() {
    return performanceArray.map(function(p){return p.report()});
  }

  this.getIndex = function(group) {
    if (group) {
      return index.groups[group]
    } else {
      return index
    }
  }

  this.middleware = function cache(strDuration, middlewareToggle, localOptions) {
    var duration = instance.getDuration(strDuration)
    var opt = {}

    middlewareOptions.push({
      options: opt
    })

    var options = function (localOptions) {
      if (localOptions) {
        middlewareOptions.find(function (middleware) {
          return middleware.options === opt
        }).localOptions = localOptions
      }

      syncOptions()

      return opt
    }

    options(localOptions)

    /**
     * A Function for non tracking performance
     */
    function NOOPCachePerformance() {
      this.report = this.hit = this.miss = function() {} // noop;
    }

    /**
     * A function for tracking and reporting hit rate.  These statistics are returned by the getPerformance() call above.
     */
    function CachePerformance() {

      /**
       * Tracks the hit rate for the last 100 requests.
       * If there have been fewer than 100 requests, the hit rate just considers the requests that have happened.
       */
      this.hitsLast100=new Uint8Array(100/4) // each hit is 2 bits

      /**
       * Tracks the hit rate for the last 1000 requests.
       * If there have been fewer than 1000 requests, the hit rate just considers the requests that have happened.
       */
      this.hitsLast1000=new Uint8Array(1000/4) // each hit is 2 bits

      /**
       * Tracks the hit rate for the last 10000 requests.
       * If there have been fewer than 10000 requests, the hit rate just considers the requests that have happened.
       */
      this.hitsLast10000=new Uint8Array(10000/4) // each hit is 2 bits

      /**
       * Tracks the hit rate for the last 100000 requests.
       * If there have been fewer than 100000 requests, the hit rate just considers the requests that have happened.
       */
      this.hitsLast100000=new Uint8Array(100000/4) // each hit is 2 bits

      /**
       * The number of calls that have passed through the middleware since the server started.
       */
      this.callCount=0;

      /**
       * The total number of hits since the server started
       */
      this.hitCount=0;

      /**
       * The key from the last cache hit.  This is useful in identifying which route these statistics apply to.
       */
      this.lastCacheHit=null;

      /**
       * The key from the last cache miss.  This is useful in identifying which route these statistics apply to.
       */
      this.lastCacheMiss=null;

      /**
       * Return performance statistics
       */
      this.report=function() {
        return {
          lastCacheHit: this.lastCacheHit,
          lastCacheMiss: this.lastCacheMiss,
          callCount: this.callCount,
          hitCount: this.hitCount,
          missCount: this.callCount - this.hitCount,
          hitRate: (this.callCount == 0)? null : this.hitCount/this.callCount,
          hitRateLast100: this.hitRate(this.hitsLast100),
          hitRateLast1000: this.hitRate(this.hitsLast1000),
          hitRateLast10000: this.hitRate(this.hitsLast10000),
          hitRateLast100000: this.hitRate(this.hitsLast100000),
        }
      }

      /**
       * Computes a cache hit rate from an array of hits and misses.
       * @param {Uint8Array} array An array representing hits and misses.
       * @returns a number between 0 and 1, or null if the array has no hits or misses
       */
      this.hitRate=function(array) {
        var hits=0;
        var misses=0;
        for(var i=0;i<array.length;i++) {
            var n8=array[i];
            for(j=0;j<4;j++) {
                switch(n8 & 3) {
                case 1:
                    hits++;
                    break;
                case 2:
                    misses++;
                    break;
                }
                n8>>=2;
            }
        }
        var total=hits+misses;
        if (total==0) return null;
        return hits/total;
      }

      /**
       * Record a hit or miss in the given array.  It will be recorded at a position determined
       * by the current value of the callCount variable.
       * @param {Uint8Array} array An array representing hits and misses.
       * @param {boolean} hit true for a hit, false for a miss
       * Each element in the array is 8 bits, and encodes 4 hit/miss records.
       * Each hit or miss is encoded as to bits as follows:
       * 00 means no hit or miss has been recorded in these bits
       * 01 encodes a hit
       * 10 encodes a miss 
       */
      this.recordHitInArray=function(array,hit) {
        var arrayIndex = ~~(this.callCount/4) % array.length;
        var bitOffset = this.callCount % 4 * 2; // 2 bits per record, 4 records per uint8 array element 
        var clearMask = ~(3<<bitOffset);
        var record = (hit?1:2) << bitOffset;
        array[arrayIndex] = (array[arrayIndex] & clearMask) | record;    
      }

      /**
       * Records the hit or miss in the tracking arrays and increments the call count.
       * @param {boolean} hit true records a hit, false records a miss
       */
      this.recordHit=function(hit) {
        this.recordHitInArray(this.hitsLast100,hit)
        this.recordHitInArray(this.hitsLast1000,hit)
        this.recordHitInArray(this.hitsLast10000,hit)
        this.recordHitInArray(this.hitsLast100000,hit)
        if (hit) this.hitCount++;
        this.callCount++
      }
      
      /**
       * Records a hit event, setting lastCacheMiss to the given key
       * @param {string} key The key that had the cache hit
       */
      this.hit=function(key) {
        this.recordHit(true);
        this.lastCacheHit = key;
      }

      /**
       * Records a miss event, setting lastCacheMiss to the given key
       * @param {string} key The key that had the cache miss
       */
      this.miss=function(key) {
        this.recordHit(false);
        this.lastCacheMiss = key;
      }
    }
    var perf = globalOptions.trackPerformance ? new CachePerformance() : new NOOPCachePerformance()
    performanceArray.push(perf);

    debug('middleware init')
    var cache = async function(ctx, next) {
      async function bypass() {
        debug('bypass detected, skipping cache.')
        return await next()
      }

      // initial bypass chances
      if (!opt.enabled) return await bypass()
      if (ctx.headers['x-apicache-bypass'] || ctx.headers['x-apicache-force-fetch']) return await bypass()

      // embed timer
      ctx.apicacheTimer = new Date()

      // In Express 4.x the url is ambigious based on where a router is mounted.  originalUrl will give the full Url
      var key = ctx.url

      // Remove querystring from key if jsonp option is enabled
      if (opt.jsonp) {
        key = url.parse(key).pathname
      }

      // add appendKey (either custom function or response path)
      if (typeof opt.appendKey === 'function') {
        key += '$$appendKey=' + opt.appendKey(ctx)
      } 
      // else if (opt.appendKey.length > 0) {
      //   var appendKey = req

      //   for (var i = 0; i < opt.appendKey.length; i++) {
      //     appendKey = appendKey[opt.appendKey[i]]
      //   }
      //   key += '$$appendKey=' + appendKey
      // }

      // attempt cache hit
      var redis = opt.redisClient
      var cached = !redis ? memCache.getValue(key) : null

      // send if cache hit from memory-cache
      if (cached) {
        var elapsed = new Date() - ctx.apicacheTimer
        debug('sending cached (memory-cache) version of', key, logDuration(elapsed))
        perf.hit(key);
        return sendCachedResponse(ctx, cached, middlewareToggle, next, duration)
      }


      // send if cache hit from redis
      if (redis) {
        try {
          const data = await new Promise((resolve, reject) => {
            redis.hgetall(key, function (err, obj) {
              if (!err && obj && obj.response) {
                resolve(obj.response)
              } else {
                reject(err)
              }
            })
          })

          var elapsed = new Date() - ctx.apicacheTimer
          debug('sending cached (redis) version of', key, logDuration(elapsed))
          
          perf.hit(key);
          return sendCachedResponse(ctx, JSON.parse(data), middlewareToggle, next, duration)
        } catch (err) {
          // bypass redis on error
          perf.miss(key);
          return makeResponseCacheable(ctx, next, key, duration, strDuration, middlewareToggle)
        }
      } else {
        perf.miss(key);
        return makeResponseCacheable(ctx, next, key, duration, strDuration, middlewareToggle)
      }
    }

    cache.options = options

    return cache
  }

  this.options = function(options) {
    if (options) {
      Object.assign(globalOptions, options)
      syncOptions()

      if ('defaultDuration' in options) {
        // Convert the default duration to a number in milliseconds (if needed)
        globalOptions.defaultDuration = parseDuration(globalOptions.defaultDuration, 3600000)
      }

      return this
    } else {
      return globalOptions
    }
  }

  this.resetIndex = function() {
    index = {
      all: [],
      groups: {}
    }
  }

  this.newInstance = function(config) {
    var instance = new ApiCache()

    if (config) {
      instance.options(config)
    }

    return instance
  }

  this.clone = function() {
    return this.newInstance(this.options())
  }

  // initialize index
  this.resetIndex()
}

module.exports = new ApiCache()
