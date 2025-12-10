import { fastifyCookie }        from '@fastify/cookie'
import { fastifyFormbody }      from '@fastify/formbody'
import { fastifyMultipart }     from '@fastify/multipart'
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
import { FastifyReply }         from 'fastify'
import { FastifyRequest }       from 'fastify'
import { readFile }             from 'node:fs/promises'
import { dirname }              from 'node:path'
import { normalize }            from 'node:path'
import { parse }                from 'qs'

export type FastifyConfig = {
	assetPath:    string
	execute:      (request: Request) => Promise<Response>
	favicon:      string
	frontScripts: Array<string>
	host:         string
	manifest?:    string
	port:         number
	scriptCalls:  Array<string>
	secret:       string
	store:        SessionStore
}

export async function fastifyRequest(request: FastifyRequest<{ Params: Record<string, string> }>)
{
	const data = Object.assign(
		{},
		request.isMultipart() ? await multiPartData(request.body) : request.body,
		request.query
	)
	const params = { ...request.params }
	const path   = '/' + request.params['*']
	delete params['*']

	return new Request(
		request.method as Method,
		request.protocol,
		request.hostname,
		request.port,
		path,
		request.headers as Headers,
		params,
		data,
		request.session,
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

export class FastifyServer
{

	scannedFrontScripts = new SortedArray<string>()

	constructor(public config: FastifyConfig)
	{
	}

	async addImportsToFrontScripts(fromScript: string)
	{
		const basePath = dirname(fromScript)
		const content  = (await readFile(fromScript)).toString()
		const matches  = [...content.matchAll(/from\s+['"](.+\.js)['"]/g)]
		matches.push(...content.matchAll(/import\s+['"](.+\.js)['"]/g))
		matches.push(...content.matchAll(/import\(['"](.+\.js)['"]\)/g))
		this.config.scriptCalls.forEach(scriptCall => {
			matches.push(...content.matchAll(RegExp(scriptCall + '\\([\'"](.+\\.js)[\'"]', 'g')))
		})
		matches.forEach(match => {
			const fileName = normalize(
				match[1].startsWith('/node_modules/')
					? (this.config.assetPath + match[1])
					: (basePath + '/' + match[1])
			)
			const frontScript = fileName.slice(this.config.assetPath.length)
			if (!this.config.frontScripts.includes(frontScript)) {
				this.config.frontScripts.push(frontScript)
			}
		})
	}

	errorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply)
	{
		console.error(error)
		if (error.validation) {
			reply.send({
				error: 'Bad Request',
				message: 'Invalid request.',
				statusCode: 400
			})
		}
		else {
			reply.send({
				error: 'Internal Server Error',
				message: 'Something went wrong. We are working on it.',
				statusCode: 500
			})
		}
	}

	async httpCall(originRequest: FastifyRequest<{ Params: Record<string, string> }>, finalResponse: FastifyReply)
	{
		const request = await fastifyRequest(originRequest)
		const dot     = request.path.lastIndexOf('.') + 1
		if ((dot > request.path.length - 6) && !request.path.includes('./')) {
			const fileExtension = request.path.substring(dot)
			if (
				!['js', 'ts'].includes(fileExtension)
				|| request.path.startsWith('/front/')
				|| this.config.frontScripts.includes(request.path)
			) {
				const filePath = (request.path === '/favicon.png') ? this.config.favicon :
					((request.path === '/manifest.json') ? (this.config.manifest ?? request.path) : request.path)
				const mimeType = mimeTypes.get(fileExtension)
				if (mimeType) {
					const fullPath = this.config.assetPath + filePath
					if (['js', 'ts'].includes(fileExtension) && !this.scannedFrontScripts.includes(fullPath)) {
						this.scannedFrontScripts.push(fullPath)
						await this.addImportsToFrontScripts(fullPath)
					}
					return fastifyResponse(finalResponse, await assetResponse(request, fullPath, mimeType))
				}
			}
		}
		return fastifyResponse(finalResponse, await this.config.execute(request))
	}

	async run()
	{
		const server = fastify({ trustProxy: true })

		server.register(fastifyCookie)
		server.register(fastifyFormbody, { parser: str => parse(str, { allowDots: true }) })
		server.register(fastifyMultipart, { attachFieldsToBody: true, limits: { fileSize: 1e9 }})
		server.register(fastifySession, {
			cookie:            { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'strict', secure: false },
			cookieName:        'itrSid',
			saveUninitialized: false,
			secret:            this.config.secret,
			store:             this.config.store
		})

		const httpCall = this.httpCall.bind(this)
		server.delete('/*', httpCall)
		server.get   ('/*', httpCall)
		server.post  ('/*', httpCall)
		server.put   ('/*', httpCall)

		server.setErrorHandler(this.errorHandler)

		await server.listen({ host: this.config.host, port: this.config.port })

		console.log(
			'[@itrocks/fastify]'
			+ ' ' + new Date().toTimeString().split(' ')[0]
			+ ' - Server is listening on http://localhost:' + this.config.port
		)
	}

}

async function multiPartData(data: any)
{
	const result = {} as RecursiveValueObject
	for (const field of Object.values(data) as any) {
		if (field.type === 'file') {
			result[field.fieldname] = new RequestFile(field.filename, await field.toBuffer())
			continue
		}
		result[field.fieldname] = field.value
	}
	return result
}
