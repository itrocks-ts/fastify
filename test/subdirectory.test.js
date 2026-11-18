const { MemoryStore } = require('@fastify/session')
const { Response } = require('@itrocks/request-response')
const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { it } = require('node:test')
const { FastifyServer } = require('../cjs/fastify')

it('serves mounted assets and keeps routes and script discovery application-relative', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'itrocks-subdirectory-'))
	await mkdir(join(directory, 'node_modules/@itrocks/demo'), { recursive: true })
	await mkdir(join(directory, 'node_modules/vendor'), { recursive: true })
	await writeFile(join(directory, 'node_modules/@itrocks/demo/entry.js'), "import './child.js'")
	await writeFile(join(directory, 'node_modules/@itrocks/demo/child.js'), 'export const loaded = true')
	await writeFile(join(directory, 'node_modules/vendor/theme.css'), 'body {}')
	await writeFile(join(directory, 'icon.png'), 'icon')
	await writeFile(join(directory, 'manifest.json'), JSON.stringify({
		icons: [{ src: '/icon.png' }], name: '/unchanged', scope: '/',
		shortcuts: [{ icons: [{ src: '/icon.png' }], url: '/movie' }], start_url: '/'
	}))
	const frontScripts = ['/@itrocks/demo/entry.js']
	const server = new FastifyServer({
		assetPath: directory,
		execute: async request => {
			await new Promise(resolve => setImmediate(resolve))
			return new Response(JSON.stringify({
				basePath: request.basePath, path: request.path, publicUrl: request.url.pathname
			}), 302, { Location: '/next' })
		},
		favicon: '/icon.png', frontScripts, host: '127.0.0.1', manifest: '/manifest.json', port: 0,
		scriptCalls: [], secret: 'a-secure-test-secret-with-32-characters', secure: 'auto', store: new MemoryStore()
	})
	try {
		const app = server.prepare()
		for (const prefix of ['', '/showtime', '/nested/showtime']) {
			const headers = prefix ? { 'x-forwarded-prefix': prefix + '/' } : {}
			const manifest = (await app.inject({ headers, url: '/manifest.json' })).json()
			assert.equal(manifest.start_url, prefix + '/')
			assert.equal(manifest.scope, prefix + '/')
			assert.equal(manifest.icons[0].src, prefix + '/icon.png')
			assert.equal(manifest.shortcuts[0].url, prefix + '/movie')
			assert.equal(manifest.shortcuts[0].icons[0].src, prefix + '/icon.png')
			assert.equal(manifest.name, '/unchanged')
			for (const retained of prefix ? [false, true] : [false]) {
				const path = retained ? prefix : ''
				for (const asset of ['/@itrocks/demo/child.js', '/lib/vendor/theme.css', '/favicon.png']) {
					const response = await app.inject({ headers, url: path + asset })
					assert.equal(response.statusCode, 200, `${prefix}: ${asset}`)
				}
				assert.equal((await app.inject({ headers, url: path + '/package.json' })).statusCode, 404)
			}
		}
		const requests = ['', '/showtime', '/nested/showtime'].map(async basePath => {
			const response = await app.inject({ headers: { 'x-forwarded-prefix': basePath }, url: '/movie' })
			assert.deepEqual(response.json(), { basePath, path: '/movie', publicUrl: basePath + '/movie' })
			assert.equal(response.headers.location, basePath + '/next')
		})
		await Promise.all(requests)
		assert.ok(frontScripts.includes('/@itrocks/demo/child.js'))
		assert.ok(frontScripts.every(path => !path.startsWith('/showtime/')))
		for (const prefix of ['//other.example', '/foo/../bar', '/foo"bar', '/foo?bar']) {
			const response = await app.inject({ headers: { 'x-forwarded-prefix': prefix }, url: '/movie' })
			assert.equal(response.json().basePath, '')
		}
	}
	finally {
		await server.stop()
		await rm(directory, { force: true, recursive: true })
	}
})
