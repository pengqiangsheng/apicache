# Koa-apicache
> An ultra-simplified API response caching middleware for Koa using plain-english durations.

## Koa的api缓存中间件

> 基于[apicache](https://www.npmjs.com/package/apicache)改造而成，拥有`apicache@1.5.3`以下所有的功能。

## 使用文档

> 大体上分为三种使用方式：1.所有路由 2.某个路由实例下所有路由 3.某个具体的路由

```js
const Koa = require('koa')
const app = new Koa()
const Router = require('@koa/router')
const apicache = require('@koa/apicache')
const cache = apicache.middleware
const router = new Router({
  prefix: '/api'
})

// 1.缓存所有api接口
app.use(cache('2 minutes'))

// 2.缓存/api下的所有接口
router.use(cache('2 minutes'))

// 3.指定一个接口缓存/api/pqs
router.get('/pqs', cache('2 minutes'), async ctx => {
  ctx.body = {
    name: 'pqs',
    pwd: '123456'
  }
})

app
  .use(router.routes())
  .use(router.allowedMethods())
```

## 测试说明

### 安装依赖

安装以下依赖:

```js
"dependencies": {
  "@koa/router": "^8.0.8",
  "koa": "^2.11.0",
  "koa-logger": "^3.2.1",
  "nodemon": "^2.0.2",
  "redis": "^3.0.2"
}
```

运行测试脚本：

```shell
yarn test
```
or
```shell
npm run test
```

### 测试接口说明

> 测试Redis缓存需要安装Redis数据库，然后开启`test.js`第19行代码。

- /api/pqs 无缓存
- /api/ccc 无缓存
- /api/cache/pqs 使用内存缓存
- /api/cache/ccc 使用内存缓存
- /api/cache/performance 查看使用内存缓存的命中率
- /api/redis/ccc 使用Redis缓存
- /api/redis/ccc 使用Redis缓存
- /api/redis/performance 查看使用Redis缓存的命中率
- /user/:collection/:id 添加分组缓存
- /api/cache/index 查看分组情况
- /api/cache/clear/:key? 清除分组

## 版权说明

> 本项目来源于[apicache](https://www.npmjs.com/package/apicache)，如果有任何问题，请留下issue。


