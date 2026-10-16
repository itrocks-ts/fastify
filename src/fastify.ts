import { fastifyCookie }        from '@fastify/cookie'
import { fastifyFormbody }      from '@fastify/formbody'
import { fastifyMultipart }     from '@fastify/multipart'
import { CookieOptions }        from '@fastify/session'
import { fastifySession }       from '@fastify/session'
import { SessionStore }         from '@fastify/session'
import { assetResponse }        from '@itrocks/request-response'
import { Headers }              from '@itrocks/request-response'
import { Method, mimeTypes }    from '@itrocks/request-response'
import { RecursiveValueObject } from '@itrocks/request-response'
import { Request }              from '@itrocks/request-response'
import { RequestFile }          from '@itrocks/request-response'
import { Response }             from '@itrocks/request-response'
import { SortedArray }          from '@itrocks/sorted-array'
import { fastify }              from 'fastify'
import { FastifyError }         from 'fastify'
import { FastifyInstance }      from 'fastify'
import { FastifyReply }         from 'fastify'
import { FastifyRequest }       from 'fastify'
import { readFile }             from 'node:fs/promises'
import { dirname }              from 'node:path'
import { isAbsolute }           from 'node:path'
import { normalize }            from 'node:path'
import { relative }             from 'node:path'
import { resolve }              from 'node:path'
import { sep }                  from 'node:path'
import { parse }                from 'qs'

const publicAssetExtensions = new Set(['css', 'ico', 'jpg', 'png', 'svg', 'woff', 'woff2'])

export type FastifyConfig = {
	assetPath:    string
	cookie?:      CookieOptions
	execute:      (request: Request) => Promise<Response>
	favicon:      string
	fileSize?:    number
	frontScripts: Array<string>
	headers?:      Headers
	host:         string
	manifest?:    string
	port:         number
	rolling?:     boolean
	sameOrigin?:  boolean
	scriptCalls:  Array<string>
	secret:       string
	secure:       boolean | 'auto'
	store:        SessionStore
}

type Transaction = <T>(operation: (data: Record<string, any>) => T | Promise<T>) => Promise<T>
type TransactionStore = SessionStore & {
	refresh?(id: string, session: object): Promise<void>
	transact<T>(id: string, session: object, operation: (data: Record<string, any>) => T | Promise<T>): Promise<T>
}
const transactions = new WeakMap<object, Transaction>()

/** Execute against the authoritative session through the configured store, awaiting durable acknowledgement. */
export function sessionTransaction<T>(
	session: object, operation: (data: Record<string, any>) => T | Promise<T>
): Promise<T>
{
	const transaction = transactions.get(session)
	if (!transaction) throw new Error('The request session does not support transactions')
	return transaction(operation)
}

function sessionBridge(request: FastifyRequest, store?: SessionStore)
{
	const bridge = new Proxy({}, {
		deleteProperty: (_target, property) => request.session ? delete (request.session as any)[property] : true,
		get:            (_target, property) => {
			const session = request.session as any
			if (property === 'reload' && store && 'refresh' in store) return (callback?: (error?: unknown) => void) => {
				const operation = sessionOperation(request, session, () =>
					(store as TransactionStore).refresh!(session.sessionId, session))
				if (callback) { void operation.then(() => callback(), callback); return }
				return operation
			}
			const value   = session?.[property]
			return (typeof value === 'function') ? value.bind(session) : value
		},
		getOwnPropertyDescriptor: (_target, property) => ({
			configurable: true,
			enumerable:   !!request.session && Object.prototype.propertyIsEnumerable.call(request.session, property)
		}),
		has:     (_target, property) => !!request.session && (property in request.session),
		ownKeys: () => request.session ? Reflect.ownKeys(request.session) : [],
		set:     (_target, property, value) => {
			request.session ??= {} as any
			(request.session as any)[property] = value
			return true
		}
	})
	if (store && ('transact' in store)) transactions.set(bridge, operation => {
		if (!request.session) throw new Error('The request session has ended')
		const session = request.session
		return sessionOperation(request, session, () =>
			(store as TransactionStore).transact(session.sessionId, session, operation))
	})
	return bridge
}

/** Stop response autosave after the store rejects this request generation, preserving the caller's response. */
async function sessionOperation<T>(request: FastifyRequest, session: object, operation: () => Promise<T>): Promise<T>
{
	try { return await operation() }
	catch (error) {
		if ((error as { code?: string } | null)?.code === 'SESSION_STALE' && request.session === session)
			request.session = null as any
		throw error
	}
}

export async function fastifyRequest(
	request: FastifyRequest<{ Params: Record<string, string> }>, store?: SessionStore
)
{
	const data = Object.assign(
		{},
		request.isMultipart() ? await multipartData(request.body) : request.body,
		request.query
	)
	const params = { ...request.params }
	const path   = '/' + request.params['*']
	delete params['*']

	return new Request(
		request.method as Method,
		request.protocol,
		request.hostname,
		request.port ?? 0,
		path,
		request.headers as Headers,
		params,
		data,
		sessionBridge(request, store),
		request
	)
}

export function fastifyResponse(fastifyResponse: FastifyReply, response: Response)
{
	for (const [index, value] of Object.entries(response.headers)) {
		fastifyResponse.header(index, value)
	}
	fastifyResponse.statusCode = response.statusCode
	return fastifyResponse.send(response.body)
}

export function requestIsSameOrigin(request: FastifyRequest): boolean
{
	if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true
	const origin    = request.headers.origin
	const fetchSite = request.headers['sec-fetch-site']
	if (typeof origin === 'string') {
		if (origin === 'null') return fetchSite === 'same-origin'
		try {
			return new URL(origin).origin === new URL(`${request.protocol}://${request.host}`).origin
		}
		catch {
			return false
		}
	}
	return !fetchSite || ['none', 'same-origin'].includes(fetchSite)
}

export class FastifyServer
{

	private discovery?: Promise<void>

	scannedFrontScripts = new SortedArray<string>()

	server?: FastifyInstance

	constructor(public config: FastifyConfig)
	{
	}

	async addImportsToFrontScripts(fromScript: string)
	{
		const assetPath      = resolve(this.config.assetPath)
		const contained      = (filePath: string) => {
			const fromAssetPath = relative(assetPath, filePath)
			return (fromAssetPath !== '..')
				&& !fromAssetPath.startsWith('..' + sep)
				&& !isAbsolute(fromAssetPath)
		}
		const fromScriptPath = resolve(fromScript)
		if (!contained(fromScriptPath)) return
		const basePath = dirname(fromScriptPath)
		const content  = (await readFile(fromScriptPath)).toString()
		const matches  = [...content.matchAll(/from\s+['"]([^'"]+\.js)['"]/g)]
		matches.push(...content.matchAll(/import\s+['"]([^'"]+\.js)['"]/g))
		matches.push(...content.matchAll(/import\(['"]([^'"]+\.js)['"]\)/g))
		this.config.scriptCalls.forEach(scriptCall => {
			const escapedCall = scriptCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			matches.push(...content.matchAll(RegExp(escapedCall + '\\([\'"]([^\'"]+\\.js)[\'"]', 'g')))
		})
		matches.forEach(match => {
			const matchPath = match[1]
			const fileName  = resolve(normalize(
				matchPath.startsWith('@itrocks/')
					? (assetPath + '/' + matchPath)
					: (
						matchPath.startsWith('/lib/')
							? (assetPath + matchPath)
							: (
								matchPath.startsWith('/node_modules/')
									? (assetPath + '/lib/' + matchPath.slice(14))
									: (basePath + '/' + matchPath)
					))
			))
			if (!contained(fileName)) return
			const frontScript = fileName.slice(assetPath.length)
				.replace(/^\/node_modules\/@itrocks\//, '/@itrocks/')
				.replace(/^\/node_modules\//, '/lib/')
			if (!this.config.frontScripts.includes(frontScript)) {
				this.config.frontScripts.push(frontScript)
			}
		})
	}

	private discoverFrontScripts(): Promise<void>
	{
		// Templates register entries dynamically. Resolve their graph even when cached parents skip HTTP entirely.
		return this.discovery ??= (async () => {
			while (true) {
				const file = this.config.frontScripts.map(script => resolve(this.config.assetPath, '.' + script
					.replace(/^\/@itrocks\//, '/node_modules/@itrocks/').replace(/^\/lib\//, '/node_modules/')))
					.find(path => !this.scannedFrontScripts.includes(path))
				if (!file) break
				try { await this.addImportsToFrontScripts(file) }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
				this.scannedFrontScripts.push(file)
			}
		})().finally(() => { this.discovery = undefined })
	}

	errorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply)
	{
		console.error('[itrocks-fastify] Request failed', {
			code:       error.code,
			name:       error.name,
			statusCode: error.statusCode
		})
		if (error.validation) {
			reply.code(400).send({
				error: 'Bad Request',
				message: 'Invalid request.',
				statusCode: 400
			})
		}
		else {
			reply.code(500).send({
				error: 'Internal Server Error',
				message: 'Something went wrong. We are working on it.',
				statusCode: 500
			})
		}
	}

	async httpCall(originRequest: FastifyRequest<{ Params: Record<string, string> }>, finalResponse: FastifyReply)
	{
		if (this.config.sameOrigin && !requestIsSameOrigin(originRequest)) {
			return finalResponse.code(404).send({ error: 'resource_not_found' })
		}
		const request = await fastifyRequest(originRequest, this.config.store)
		const dot     = request.path.lastIndexOf('.') + 1
		if ((dot > request.path.length - 6) && !request.path.includes('./')) {
			const fileExtension = request.path.substring(dot)
			const favicon  = request.path === '/favicon.png'
			const manifest = (request.path === '/manifest.json') && !!this.config.manifest
			const script   = fileExtension === 'js' && (
				request.path.startsWith('/front/') || this.config.frontScripts.includes(request.path)
			)
			if (favicon || manifest || script || publicAssetExtensions.has(fileExtension)) {
				const filePath = favicon ? this.config.favicon : manifest ? this.config.manifest! : request.path
				const mimeType = mimeTypes.get(fileExtension)
				if (mimeType) {
					const assetPath = resolve(this.config.assetPath)
					const assetFile = filePath
						.replace(/^\/@itrocks\//, '/node_modules/@itrocks/')
						.replace(/^\/lib\//, '/node_modules/')
					const fullPath     = resolve(assetPath, '.' + assetFile)
					const relativePath = relative(assetPath, fullPath)
					if (
						(relativePath === '..')
						|| relativePath.startsWith('..' + sep)
						|| isAbsolute(relativePath)
					) return fastifyResponse(finalResponse, new Response('', 404))
					if (['js', 'ts'].includes(fileExtension) && !this.scannedFrontScripts.includes(fullPath)) {
						this.scannedFrontScripts.push(fullPath)
						await this.addImportsToFrontScripts(fullPath)
					}
					return fastifyResponse(finalResponse, await assetResponse(request, fullPath, mimeType))
				}
			}
			if (mimeTypes.has(fileExtension)) {
				return fastifyResponse(finalResponse, new Response('', 404))
			}
		}
		const response = await this.config.execute(request)
		await this.discoverFrontScripts()
		return fastifyResponse(finalResponse, response)
	}

	prepare()
	{
		const server = this.server = fastify({ trustProxy: true })

		server.register(fastifyCookie)
		server.register(fastifyFormbody, { parser: str => parse(str, { allowDots: true }) })
		server.register(fastifyMultipart, {
			attachFieldsToBody: true,
			limits:             { fileSize: this.config.fileSize ?? 1e9 }
		})
		server.register(fastifySession, {
			cookie:            {
				httpOnly: true,
				maxAge:   30 * 24 * 60 * 60 * 1000,
				sameSite: 'none',
				secure:   this.config.secure,
				...this.config.cookie
			},
			cookieName:        'itrSid',
			rolling:           this.config.rolling,
			saveUninitialized: false,
			secret:            this.config.secret,
			store:             this.config.store
		})
		server.addHook('onReady', () => this.discoverFrontScripts())
		server.addHook('onSend', async (_request, reply, payload) => {
			for (const [name, value] of Object.entries(this.config.headers ?? {})) {
				if (!reply.hasHeader(name)) reply.header(name, value)
			}
			return payload
		})

		const httpCall = this.httpCall.bind(this)
		server.delete('/*', httpCall)
		server.get   ('/*', httpCall)
		server.post  ('/*', httpCall)
		server.put   ('/*', httpCall)

		server.setErrorHandler(this.errorHandler)
		return server
	}

	async run()
	{
		const server = this.prepare()

		await server.listen({ host: this.config.host, port: this.config.port })

		console.log(
			'[@itrocks/fastify]'
			+ ' ' + new Date().toTimeString().split(' ')[0]
			+ ' - Server is listening on http://localhost:' + this.config.port
		)
	}

	async stop()
	{
		await this.server?.close()
		this.server = undefined
	}

}

async function multipartData(data: any)
{
	const result = {} as RecursiveValueObject
	for (const field of Object.values(data) as any) {
		const [fieldname, value] = await multipartItem(field)
		if (!(fieldname in result)) {
			result[fieldname] = value
			continue
		}
		if (!Array.isArray(result[fieldname])) {
			result[fieldname] = [result[fieldname]]
		}
		if (Array.isArray(value)) {
			result[fieldname].push(...value)
			continue
		}
		result[fieldname].push(value)
	}
	return result
}

async function multipartItem(data: any)
{
	if (Array.isArray(data) && data.length) {
		const fieldname = data[0].fieldname
		const result    = []
		for (const item of data) {
			const [,value] = await multipartItem(item) as any
			result.push(value)
		}
		return [fieldname, result]
	}
	if (typeof data === 'object') {
		if (data.type === 'file') {
			return [data.fieldname, new RequestFile(data.filename, await data.toBuffer())]
		}
		return [data.fieldname, data.value]
	}
	throw new Error('Unmanaged multipart entry ' + JSON.stringify(data))
}
