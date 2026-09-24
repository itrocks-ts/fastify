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

function sessionBridge(request: FastifyRequest)
{
	return new Proxy({}, {
		deleteProperty: (_target, property) => request.session ? delete (request.session as any)[property] : true,
		get:            (_target, property) => {
			const session = request.session as any
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
}

export async function fastifyRequest(request: FastifyRequest<{ Params: Record<string, string> }>)
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
		sessionBridge(request),
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
	const origin = request.headers.origin
	const fetchSite = request.headers['sec-fetch-site']
	if (typeof origin === 'string') {
		if (origin === 'null') return fetchSite === 'same-origin'
		try {
			return new URL(origin).origin === new URL(`${request.protocol}://${request.host}`).origin
		}
		catch { return false }
	}
	return !fetchSite || ['none', 'same-origin'].includes(fetchSite)
}

export class FastifyServer
{

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
		const request = await fastifyRequest(originRequest)
		const dot     = request.path.lastIndexOf('.') + 1
		if ((dot > request.path.length - 6) && !request.path.includes('./')) {
			const fileExtension = request.path.substring(dot)
			const favicon = request.path === '/favicon.png'
			const manifest = request.path === '/manifest.json' && !!this.config.manifest
			const script = fileExtension === 'js' && (
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
		return fastifyResponse(finalResponse, await this.config.execute(request))
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
