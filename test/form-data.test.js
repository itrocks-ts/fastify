const { MemoryStore }          = require('@fastify/session')
const { RequestFile, Response } = require('@itrocks/request-response')
const assert                   = require('node:assert/strict')
const { it }                   = require('node:test')
const { FastifyServer }        = require('../cjs/fastify')

it('parses dotted fields in both form encodings and preserves multipart files', async () => {
	const requests = []
	const server = new FastifyServer({
		assetPath: process.cwd(),
		execute: async request => {
			requests.push(request.data)
			return new Response('ok')
		},
		favicon: '', frontScripts: [], host: '127.0.0.1', port: 0, scriptCalls: [],
		secret: 'a-secure-test-secret-with-32-characters', secure: 'auto', store: new MemoryStore()
	})
	try {
		const app = server.prepare()
		const url = '/save'
		const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' }
		const form = 'crew._present=1&crew.1.id=7&crew.1.active=0&crew.1.active=1'
		assert.equal((await app.inject({ headers: formHeaders, method: 'POST', payload: form, url })).statusCode, 200)
		assert.deepEqual(requests[0], { crew: { 1: { id: '7', active: ['0', '1'] }, _present: '1' } })

		const uploads = [
			'--test', 'Content-Disposition: form-data; name="crew._present"', '', '1',
			'--test', 'Content-Disposition: form-data; name="crew.1.attachment"; filename="test.txt"',
			'Content-Type: text/plain', '', 'file content', '--test--', ''
		].join('\r\n')
		const headers = { 'content-type': 'multipart/form-data; boundary=test' }
		assert.equal((await app.inject({ headers, method: 'POST', payload: uploads, url })).statusCode, 200)
		assert.deepEqual(requests[1], {
			crew: { 1: { attachment: new RequestFile('test.txt', Buffer.from('file content')) }, _present: '1' }
		})

		const payload = form + '&field=1'.repeat(1000)
		assert.equal((await app.inject({ headers: formHeaders, method: 'POST', payload, url })).statusCode, 400)
		assert.equal(requests.length, 2)
	}
	finally {
		await server.stop()
	}
})
