import { makeBook } from '../vendor/foliate-js/view.js'
import { loadSettings, applyAppTheme, saveSettings, THEMES } from './themes.js'
import { getAllBooks, getBook, saveBook, deleteBook } from './db.js'
import { LibraryView } from './library.js'
import { ReaderController } from './reader.js'
import {
    fingerprintFile, formatLanguageMap, formatContributor, getFormatBadge,
} from './utils.js'

const THEME_ORDER = ['light', 'stone', 'sage', 'nord', 'charcoal', 'obsidian', 'sepia']

class FolioApp {
    settings
    library
    reader
    #dragDepth = 0

    constructor() {
        this.settings = loadSettings()
        applyAppTheme(this.settings.theme)

        this.library = new LibraryView({
            onOpenBook: id => this.openBookById(id),
            onDeleteBook: id => this.removeBook(id),
            onBrowseFiles: () => document.getElementById('file-input')?.click(),
        })

        this.reader = new ReaderController(this.settings, {
            onCloseReader: () => this.showLibrary(),
            onToast: msg => this.toast(msg),
            onOpenModal: id => this.openModal(id),
        })

        this.#bindGlobalUI()
        this.#boot()
    }

    #bindGlobalUI() {
        const fileInput = document.getElementById('file-input')
        fileInput?.addEventListener('change', async e => {
            const files = Array.from(e.target.files || [])
            e.target.value = ''
            if (files.length) await this.importFiles(files, true)
        })

        document.getElementById('lib-open-btn')?.addEventListener('click', () => {
            fileInput?.click()
        })

        document.getElementById('lib-theme-btn')?.addEventListener('click', () => {
            const idx = THEME_ORDER.indexOf(this.settings.theme)
            const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length]
            this.reader.updateSettings({ theme: next })
            this.toast(`Theme: ${THEMES[next].name}`)
        })

        document.getElementById('lib-shortcuts-btn')?.addEventListener('click', () => {
            this.openModal('shortcuts-modal')
        })

        // Global drag and drop
        const overlay = document.getElementById('global-drop-overlay')
        window.addEventListener('dragenter', e => {
            if (!e.dataTransfer?.types?.includes('Files')) return
            e.preventDefault()
            this.#dragDepth++
            if (overlay) overlay.hidden = false
        })
        window.addEventListener('dragover', e => {
            if (!e.dataTransfer?.types?.includes('Files')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
        })
        window.addEventListener('dragleave', e => {
            if (!e.dataTransfer?.types?.includes('Files')) return
            this.#dragDepth = Math.max(0, this.#dragDepth - 1)
            if (this.#dragDepth === 0 && overlay) overlay.hidden = true
        })
        window.addEventListener('drop', async e => {
            e.preventDefault()
            this.#dragDepth = 0
            if (overlay) overlay.hidden = true
            const files = Array.from(e.dataTransfer?.files || [])
            if (files.length) await this.importFiles(files, true)
        })

        // Modal dismissal
        document.querySelectorAll('.modal-backdrop').forEach(modal => {
            modal.addEventListener('click', e => {
                if (e.target === modal || e.target.closest('[data-close-modal]')) {
                    modal.hidden = true
                }
            })
        })
        window.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-backdrop:not([hidden])').forEach(m => {
                    m.hidden = true
                })
            }
        })
    }

    async #boot() {
        await this.refreshLibrary()

        const params = new URLSearchParams(location.search)
        const url = params.get('url')
        if (url) {
            try {
                await this.openFromUrl(url)
            } catch (err) {
                console.error(err)
                this.toast('Could not open book from URL')
            }
        }
    }

    async refreshLibrary() {
        const books = await getAllBooks()
        this.library.render(books)
    }

    async #extractMetadata(file) {
        const book = await makeBook(file)
        try {
            const meta = book.metadata || {}
            const title = formatLanguageMap(meta.title)
                || file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
            const author = formatContributor(meta.author)
            const publisher = formatContributor(meta.publisher)
            const language = Array.isArray(meta.language) ? meta.language[0] : (meta.language || '')
            const description = formatLanguageMap(meta.description)
            let cover = null
            try {
                const c = await book.getCover?.()
                if (c instanceof Blob && c.size > 0) cover = c
            } catch {
                // ignore missing cover
            }
            return { title, author, publisher, language, description, cover }
        } finally {
            book.destroy?.()
        }
    }

    async importFiles(files, openFirst = false) {
        let firstRecord = null
        let importedCount = 0

        for (const file of files) {
            try {
                const id = await fingerprintFile(file)
                const existing = await getBook(id)
                if (existing) {
                    if (!firstRecord) firstRecord = existing
                    continue
                }
                const meta = await this.#extractMetadata(file)
                const record = {
                    id,
                    title: meta.title,
                    author: meta.author,
                    publisher: meta.publisher,
                    language: meta.language,
                    description: meta.description,
                    format: getFormatBadge(file.name),
                    fileName: file.name,
                    fileSize: file.size,
                    file,
                    cover: meta.cover,
                    addedAt: Date.now(),
                    lastOpenedAt: Date.now(),
                    lastCfi: null,
                    fraction: 0,
                    chapterTitle: '',
                }
                await saveBook(record)
                importedCount++
                if (!firstRecord) firstRecord = record
            } catch (err) {
                console.error(`Failed to import ${file.name}:`, err)
                this.toast(`Unsupported or unreadable file: ${file.name}`)
            }
        }

        await this.refreshLibrary()

        if (importedCount > 1) {
            this.toast(`Added ${importedCount} books`)
        } else if (importedCount === 1 && !openFirst) {
            this.toast(`Added "${firstRecord.title}"`)
        }

        if (openFirst && firstRecord) {
            await this.openBookRecord(firstRecord)
        }
    }

    async openFromUrl(url) {
        this.toast('Fetching book...')
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const pathname = new URL(url, location.href).pathname
        const fileName = decodeURIComponent(pathname.split('/').pop() || 'book.epub')
        const file = new File([blob], fileName, { type: blob.type })
        await this.importFiles([file], true)
    }

    async openBookById(id) {
        const record = await getBook(id)
        if (!record) {
            this.toast('Book not found')
            return
        }
        await this.openBookRecord(record)
    }

    async openBookRecord(record) {
        document.getElementById('library-view').hidden = true
        document.getElementById('reader-view').hidden = false
        try {
            await this.reader.open(record)
        } catch (err) {
            console.error('Failed to open book:', err)
            this.toast('Could not render this book')
            await this.showLibrary()
        }
    }

    async showLibrary() {
        this.reader.close()
        document.getElementById('reader-view').hidden = true
        document.getElementById('library-view').hidden = false
        await this.refreshLibrary()
    }

    async removeBook(id) {
        const record = await getBook(id)
        if (!record) return
        if (!confirm(`Remove "${record.title}"?`)) return
        await deleteBook(id)
        await this.refreshLibrary()
        this.toast(`Removed "${record.title}"`)
    }

    openModal(id) {
        const el = document.getElementById(id)
        if (el) el.hidden = false
    }

    toast(message) {
        const container = document.getElementById('toast-container')
        if (!container) return
        const el = document.createElement('div')
        el.className = 'toast'
        el.textContent = message
        container.append(el)
        requestAnimationFrame(() => el.classList.add('show'))
        setTimeout(() => {
            el.classList.remove('show')
            setTimeout(() => el.remove(), 260)
        }, 2600)
    }
}

window.folioApp = new FolioApp()
