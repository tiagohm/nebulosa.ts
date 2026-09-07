import { errorMessage } from '../../src/core/util'
import type { PreparedSession, SessionArtifacts } from './provider'

export interface ProcessResult {
	readonly exitCode: number
	readonly timedOut: boolean
	readonly signal?: 'SIGINT' | 'SIGTERM'
	readonly error?: string
	readonly cleanupFailed?: boolean
}

// Owns each process tree until exit and cancellation cleanup finish. Output streams go directly to disk.
export class BunProcessRunner {
	constructor(private readonly root: string) {}

	async run(session: PreparedSession, artifacts: SessionArtifacts, timeoutSec: number, signal: AbortSignal): Promise<ProcessResult> {
		if (signal.aborted) return { exitCode: signal.reason === 'SIGTERM' ? 143 : 130, timedOut: false, signal: signal.reason }

		let child: Bun.Subprocess<'ignore' | Uint8Array, Bun.BunFile, Bun.BunFile>

		try {
			child = Bun.spawn([session.executable, ...session.args], {
				cwd: this.root,
				env: session.env,
				stdin: typeof session.stdin === 'string' ? new TextEncoder().encode(session.stdin) : (session.stdin ?? 'ignore'),
				stdout: Bun.file(artifacts.log),
				stderr: Bun.file(artifacts.stderr),
				detached: true,
				windowsHide: true,
			})
		} catch (error) {
			return { exitCode: 1, timedOut: false, error: errorMessage(error) }
		}

		let timer: Timer | undefined
		let termination: Promise<void> | undefined
		let terminationError: Error | undefined
		let timedOut = false

		const stop = () => {
			termination ??= this.terminateTree(child).catch((error: unknown) => {
				terminationError = error instanceof Error ? error : new Error(String(error))
				// A failed tree-kill helper must not leave the leader running without a timeout.
				if (child.exitCode === null) child.kill('SIGKILL')
			})
		}

		const deadline = performance.now() + timeoutSec * 1000

		const scheduleTimeout = () => {
			const remaining = deadline - performance.now()
			if (remaining > 0) timer = setTimeout(scheduleTimeout, Math.min(remaining, 2147483647))
			else {
				timedOut = true
				stop()
			}
		}

		signal.addEventListener('abort', stop, { once: true })

		try {
			if (signal.aborted) stop()
			else if (timeoutSec > 0) scheduleTimeout()

			const exitCode = await child.exited
			clearTimeout(timer)

			// A leader can exit on TERM while descendants still hold the output files open.
			if (!termination && process.platform !== 'win32' && this.signalGroup(child.pid, 0)) stop()
			await termination
			const stoppedBy = signal.aborted ? signal.reason : child.signalCode

			return {
				exitCode,
				timedOut,
				signal: !timedOut && (stoppedBy === 'SIGINT' || stoppedBy === 'SIGTERM') ? stoppedBy : undefined,
				error: terminationError ? `Unable to terminate the session process tree: ${terminationError.message}` : undefined,
				cleanupFailed: terminationError !== undefined,
			}
		} finally {
			clearTimeout(timer)
			signal.removeEventListener('abort', stop)
			await termination
		}
	}

	private signalGroup(pid: number, signal: NodeJS.Signals | 0) {
		try {
			process.kill(-pid, signal)
			return true
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
			throw error
		}
	}

	private async terminateTree(child: Bun.Subprocess) {
		if (process.platform === 'win32') {
			const killer = Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', '/F'], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', windowsHide: true })
			const [exitCode, stderr] = await Promise.all([killer.exited, new Response(killer.stderr).text()])

			if (exitCode !== 0 && child.exitCode === null) {
				child.kill('SIGKILL')
				throw new Error(`taskkill failed (${exitCode}): ${stderr.trim()}`)
			}
		} else if (this.signalGroup(child.pid, 'SIGTERM')) {
			const deadline = performance.now() + 15000

			while (performance.now() < deadline && this.signalGroup(child.pid, 0)) {
				await Bun.sleep(100)
			}

			this.signalGroup(child.pid, 'SIGKILL')
		}

		await child.exited
	}
}
