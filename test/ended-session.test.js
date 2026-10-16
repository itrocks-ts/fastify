const { FileStore } = require('@itrocks/fastify-file-session-store')
const { Response } = require('@itrocks/request-response')
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { mkdtemp } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { FastifyServer, sessionTransaction } = require('../cjs/fastify')

const deferred = () => {
	let resolve
	const promise = new Promise(done => { resolve = done })
	return { promise, resolve }
}
const json = (value, status = 200) =>
	new Response(JSON.stringify(value), status, { 'Content-Type': 'application/json' })

test('actual HTTP preserves handled expiry and revoke errors without response autosave or cookie renewal', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ended-session-http-'))
	let acquired, release, server, url
	const config = {
		assetPath: directory, favicon: '', frontScripts: [], host: '127.0.0.1', port: 0, scriptCalls: [],
		secret: randomBytes(32).toString('hex'), secure: false, cookie: { sameSite: 'lax' },
		execute: async request => {
			const session = request.session
			if (request.path === '/seed') session.marker = 'current'
			if (request.path === '/expire') session.cookie.expires = new Date(Date.now() - 1000)
			if (request.path === '/revoke') await session.destroy()
			if (request.path.startsWith('/pending/')) {
				acquired.resolve(session.sessionId)
				await release.promise
				try {
					if (request.path === '/pending/transaction')
						await sessionTransaction(session, data => { data.marker = 'obsolete' })
					else if (request.path === '/pending/refresh') await session.reload()
					else await new Promise((resolve, reject) => session.reload(error => error ? reject(error) : resolve()))
				}
				catch (error) {
					if (error.code === 'SESSION_STALE') return json({ error: error.code }, 410)
					throw error
				}
			}
			return json({ marker: session.marker })
		}
	}
	async function start()
	{
		server = new FastifyServer({ ...config, store: new FileStore(directory) })
		url = await server.prepare().listen({ host: '127.0.0.1', port: 0 })
	}
	await start()
	try {
		for (const operation of ['expire', 'revoke']) {
			for (const method of ['transaction', 'refresh', 'refresh-callback']) {
				const seeded = await fetch(url + '/seed')
				const cookie = seeded.headers.get('set-cookie').split(';')[0]
				const call = path => fetch(url + path, { headers: { cookie } })
				acquired = deferred()
				release = deferred()
				const pending = call('/pending/' + method)
				const id = await acquired.promise
				assert.equal((await call('/' + operation)).status, 200)
				release.resolve()
				const ended = await pending
				assert.equal(ended.status, 410, operation + ' ' + method)
				assert.deepEqual(await ended.json(), { error: 'SESSION_STALE' })
				assert.equal(ended.headers.get('set-cookie'), null)
				assert.equal((await server.config.store.list()).some(item => item.id === id), false)
				await server.stop()
				await start()
				assert.deepEqual(await (await call('/read')).json(), {})
				assert.deepEqual(await (await call('/seed')).json(), { marker: 'current' })
			}
		}
	}
	finally { await server.stop() }
})

test('ordinary transaction and response storage failures remain visible through actual HTTP', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'session-storage-errors-'))
	const store = new FileStore(directory)
	const originalSet = store.set.bind(store)
	const originalTransact = store.transact.bind(store)
	let failure
	const error = Object.assign(new Error('Synthetic storage failure'), { code: 'EIO' })
	store.set = (id, session, callback) => failure === 'autosave'
		? callback(error) : originalSet(id, session, callback)
	store.transact = (id, session, operation) => failure === 'transaction'
		? Promise.reject(error) : originalTransact(id, session, operation)
	const server = new FastifyServer({
		assetPath: directory, favicon: '', frontScripts: [], host: '127.0.0.1', port: 0, scriptCalls: [],
		secret: randomBytes(32).toString('hex'), secure: false, cookie: { sameSite: 'lax' }, store,
		execute: async request => {
			if (request.path === '/seed') request.session.marker = 'current'
			if (request.path === '/transaction')
				await sessionTransaction(request.session, data => { data.marker = 'transaction' })
			if (request.path === '/autosave') request.session.marker = 'autosave'
			return json({ marker: request.session.marker })
		}
	})
	const url = await server.prepare().listen({ host: '127.0.0.1', port: 0 })
	try {
		const seed = await fetch(url + '/seed')
		const cookie = seed.headers.get('set-cookie').split(';')[0]
		const call = path => fetch(url + path, { headers: { cookie } })
		for (failure of ['transaction', 'autosave']) {
			const failed = await call('/' + failure)
			assert.equal(failed.status, 500)
			assert.equal(failed.headers.get('set-cookie'), null)
		}
		failure = undefined
		assert.deepEqual(await (await call('/read')).json(), { marker: 'current' })
		assert.deepEqual(await (await call('/transaction')).json(), { marker: 'transaction' })
		assert.deepEqual(await (await call('/autosave')).json(), { marker: 'autosave' })
	}
	finally { await server.stop() }
})

test('a late stale transaction does not detach a regenerated request session', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'session-regeneration-'))
	const store = new FileStore(directory)
	const originalTransact = store.transact.bind(store)
	let hold = false
	const release = deferred()
	store.transact = async (id, session, operation) => {
		if (hold) {
			hold = false
			await release.promise
			throw Object.assign(new Error('Ended generation'), { code: 'SESSION_STALE' })
		}
		return originalTransact(id, session, operation)
	}
	const server = new FastifyServer({
		assetPath: directory, favicon: '', frontScripts: [], host: '127.0.0.1', port: 0, scriptCalls: [],
		secret: randomBytes(32).toString('hex'), secure: false, cookie: { sameSite: 'lax' }, store,
		execute: async request => {
			if (request.path === '/regenerate') {
				hold = true
				const pending = sessionTransaction(request.session, () => {}).catch(error => error)
				await request.session.regenerate()
				request.session.marker = 'regenerated'
				release.resolve()
				assert.equal((await pending).code, 'SESSION_STALE')
			}
			return json({ marker: request.session.marker })
		}
	})
	const url = await server.prepare().listen({ host: '127.0.0.1', port: 0 })
	try {
		const response = await fetch(url + '/regenerate')
		assert.equal(response.status, 200)
		const cookie = response.headers.get('set-cookie').split(';')[0]
		assert.deepEqual(await (await fetch(url + '/read', { headers: { cookie } })).json(), { marker: 'regenerated' })
	}
	finally { await server.stop() }
})
