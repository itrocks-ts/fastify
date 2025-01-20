import { fastifyCookie }                from '@fastify/cookie'
import { fastifyFormbody }              from '@fastify/formbody'
import { fastifyMultipart }             from '@fastify/multipart'
import { fastifySession, SessionStore } from '@fastify/session'
import { assetResponse, Headers }       from '@itrocks/request-response'
import { Method, mimeTypes }            from '@itrocks/request-response'
import { RecursiveStringObject }        from '@itrocks/request-response'
import { Request, Response }            from '@itrocks/request-response'
import { fastify }                      from 'fastify'
import { FastifyReply, FastifyRequest } from 'fastify'
import { parse }                        from 'qs'

export type FastifyConfig = {
	assetPath:    string
	execute:      (request: Request) => Promise<Response>
	favicon:      string
	frontScripts: Array<string>
	port:         number
	secret:       string
	store:        SessionStore
}

export async function fastifyRequest(request: FastifyRequest<{ Params: Record<string, string> }>)
{
	const data = (request.body ?? request.query) as RecursiveStringObject
	const files: Record<string, Buffer> = {}
	const params = { ...request.params }
	const path   = '/' + request.params['*']
	delete params['*']

	if (request.isMultipart()) {
		for await (const part of request.parts()) {
			if (part.type === 'field') {
				data[part.fieldname] = part.value as string
			}
			if (part.type === 'file') {
				files[part.filename] = await part.toBuffer()
			}
		}
	}

	return new Request(
		request.method as Method,
		request.protocol,
		request.hostname,
		request.port,
		path,
		request.headers as Headers,
		params,
		data,
		files,
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

	constructor(public config: FastifyConfig)
	{}

	async httpCall(
		originRequest: FastifyRequest<{ Params: Record<string, string> }>,
		finalResponse: FastifyReply
	) {
		const request = await fastifyRequest(originRequest)
		const dot     = request.path.lastIndexOf('.') + 1
		if ((dot > request.path.length - 6) && !request.path.includes('./')) {
			const fileExtension = request.path.substring(dot)
			if (
				!['js', 'ts'].includes(fileExtension)
				|| request.path.startsWith('/front/')
				|| this.config.frontScripts.includes(request.path)
			) {
				const filePath = (request.path === '/favicon.ico') ? this.config.favicon : request.path
				const mimeType = mimeTypes.get(fileExtension)
				if (mimeType) {
					return fastifyResponse(finalResponse, await assetResponse(request, this.config.assetPath + filePath, mimeType))
				}
			}
		}
		return fastifyResponse(finalResponse, await this.config.execute(request))
	}

	run()
	{
		const server = fastify({ trustProxy: true })

		server.register(fastifyCookie)
		server.register(fastifyFormbody, { parser: str => parse(str, { allowDots: true }) })
		server.register(fastifyMultipart)
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

		server.listen({ port: this.config.port }).then()

		console.log('server is listening on http://localhost:' + this.config.port)
	}

}
