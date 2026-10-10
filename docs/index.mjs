import { codeToHtml } from 'https://esm.sh/shiki@4.5.0/bundle/web'

const SYNTAX_HIGHLIGHT_THEME = 'dark-plus'

export class Capability {
	#siblings = []
	#codes = []
	#colapsed = true
	#syntaxHighlighted = false

	constructor(element) {
		this.element = element
	}

	init() {
		for (let next = this.element.nextElementSibling; next !== null && next.tagName !== 'H3' && next.tagName !== 'H2' && next.tagName !== 'H1'; next = next.nextElementSibling) {
			next.classList.toggle('colapsed', true)
			this.#siblings.push(next)
			if (next.tagName === 'SH') this.#codes.push(next)
		}

		this.element.addEventListener('click', this.toggle.bind(this))
	}

	colapsed(enabled, event) {
		const colapsed = enabled ?? !this.#colapsed
		for (const element of this.#siblings) element.classList.toggle('colapsed', colapsed)
		this.#colapsed = colapsed
		this.element.classList.toggle('expanded', !colapsed)
		if (colapsed) event?.preventDefault()
	}

	toggle(event) {
		this.colapsed(undefined, event)
	}

	expand(event) {
		this.colapsed(false, event)
		this.syntaxHighlight()
	}

	colapse(event) {
		this.colapsed(true, event)
	}

	async syntaxHighlight() {
		if (this.#syntaxHighlighted) return

		for (const code of this.#codes) {
			const lang = code.dataset.lang
			code.innerHTML = await codeToHtml(code.textContent, { lang, theme: SYNTAX_HIGHLIGHT_THEME })
		}

		this.#syntaxHighlighted = true
	}
}

export class Documenter {
	#capabilities = new Map()

	init() {
		const elements = document.getElementById('main')?.getElementsByTagName('h3')

		for (const element of elements) {
			const capability = new Capability(element)
			this.#capabilities.set(element.id, capability)
			capability.init()
		}

		this.expandFromHash()
	}

	expandFromHash() {
		const id = location.hash.replace('#/?id=', '')
		if (id) this.expandFromId(id)
	}

	expandFromId(id) {
		this.#capabilities.get(id)?.expand()
	}

	async syntaxHighlightWithLang(lang) {
		const codes = document.querySelectorAll(`sh.${lang}`)

		for (const code of codes) {
			code.innerHTML = await codeToHtml(code.textContent, { lang, theme: SYNTAX_HIGHLIGHT_THEME })
		}
	}
}

window.documenter = new Documenter()
