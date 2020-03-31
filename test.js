const Koa = require('koa')
const app = new Koa()
const redis = require('redis')
const Router = require('@koa/router')
const logger = require('koa-logger')
const apicache = require('./index')
// memory cache
const cache = apicache
              .options({
                appendKey: ctx => ctx.method,
                trackPerformance: true,
                debug: true
              })
              .middleware
// a apicahe new instance with redis
const redisApiCache = apicache
                      .newInstance({
                        // redisClient: redis.createClient(),
                        trackPerformance: true,
                        debug: true
                      })
// redis cache (use newInstance, In order to distinguish between redis cache and memory cache. )
const cacheWithRedis = redisApiCache.middleware
// normal router
const router = new Router()
// memory cache router
const cacheRouter = new Router({
  prefix: '/api/cache'
})
// redis cache router
const redisRouter = new Router({
  prefix: '/api/redis'
})

app.use(logger())

// 1.所有路由缓存
// app.use(cache('2 minutes', (ctx => ctx.url !== '/api/cache/performance')))

router.get('/api/pqs', async ctx => {
  ctx.body = {
    name: 'pqs',
    pwd: '123456'
  }
})

router.get('/api/ccc', async ctx => {
  ctx.body = {
    name: 'ccc',
    pwd: '123456'
  }
})

// 添加分组
router.get('/user/:collection/:id', cache('4 minutes'), async ctx => {
  const params = ctx.params
  ctx.apicacheGroup = ctx.params.collection
  ctx.body = {
    params
  }
})

// 查看分组key
router.get('/api/cache/index', async ctx => {
  ctx.body = apicache.getIndex()
})

// 清除某个缓存（不传清除所有）
router.get('/api/cache/clear/:key?', async ctx => {
  ctx.body = apicache.clear(ctx.params.key || ctx.query.key)
})

// 查看Memory cache的命中率
router.get('/api/cache/performance', async ctx => {
  ctx.body = apicache.getPerformance()
})

// 查看Redis cache的命中率
router.get('/api/redis/performance', async ctx => {
  ctx.body = redisApiCache.getPerformance()
})

// 2.缓存所有cacheRouter实例下的路由
// cacheRouter.use(cache('2 minutes'))

// 3.指定cacheRouter的具体某个路由缓存
cacheRouter.get('/pqs', cache('2 minutes'), async ctx => {
  ctx.set('etag', 'pqstest')
  ctx.body = {
    name: 'pqs',
    pwd: '123456'
  }
})

cacheRouter.get('/ccc', cache('2 minutes'), async ctx => {
  ctx.body = {
    name: 'ccc',
    pwd: '123456'
  }
})

redisRouter.use('/pqs', cacheWithRedis('3 minutes'))
redisRouter.use('/ccc', cacheWithRedis('3 minutes'))

redisRouter.get('/pqs', async ctx => {
  ctx.body = {
    name: 'pqs111',
    pwd: '123456'
  }
})

redisRouter.get('/ccc', async ctx => {
  ctx.body = {
    name: 'ccc1111',
    pwd: '1234568'
  }
})

app
  .use(router.routes())
  .use(cacheRouter.routes())
  .use(redisRouter.routes())
  .use(router.allowedMethods())


app.listen(775, () => {
  console.log('serve is running 775 port!')
})