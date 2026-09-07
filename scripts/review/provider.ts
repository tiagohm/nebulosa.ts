// Provider-neutral session contracts. Metrics are optional and supplied only by the provider.

export type ReviewMode = 'review' | 'fix'

export type ProviderOption = 'maxTurns' | 'model' | 'effort' | 'allowSubagents'

export interface ProviderOptions {
	readonly maxTurns?: number
	readonly model?: string
	readonly effort?: string
	readonly allowSubagents?: boolean
}

export interface ReviewOptions {
	readonly provider: string
	readonly mode: ReviewMode
	readonly force: boolean
	readonly dryRun: boolean
	readonly status: boolean
	readonly help: boolean
	readonly refreshList: boolean
	readonly filesPath?: string
	readonly files: readonly string[]
	readonly limit: number
	readonly timeout: number
	readonly providerOptions: ProviderOptions
}

export interface SessionArtifacts {
	readonly file: string
	readonly mode: ReviewMode
	readonly prompt: string
	readonly log: string
	readonly report: string
	readonly stderr: string
}

export interface SessionRequest {
	readonly root: string
	readonly file: string
	readonly mode: ReviewMode
	readonly options: ProviderOptions
	readonly artifacts: SessionArtifacts
}

export interface PreparedSession {
	readonly executable: string
	readonly args: readonly string[]
	readonly env: NodeJS.ProcessEnv
	readonly stdin?: string | Uint8Array
}

export interface ReviewMetrics {
	readonly turns?: number
	readonly costUsd?: number
	readonly findingsCount?: number
}

export interface ReviewResult {
	readonly report: string
	readonly classification: 'ok' | 'error' | 'incomplete'
	stopReason: string
	readonly sessionId?: string
	readonly metrics?: ReviewMetrics
}

export interface ReviewProvider {
	readonly id: string
	readonly capabilities: ReadonlySet<ProviderOption>
	readonly defaults: Readonly<ProviderOptions>
	readonly prepareSession: (request: SessionRequest) => PreparedSession | Promise<PreparedSession>
	readonly parseResult: (artifacts: SessionArtifacts) => Promise<ReviewResult>
}
