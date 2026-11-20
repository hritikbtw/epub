import { escapeHtml, formatRelativeTime, getCoverPalette, formatBytes } from './utils.js'

export class LibraryView {
    #coverUrls = []
    #books = []
    #searchQuery = ''
    #sortBy = 'lastOpened'
    #callbacks

    constructor(callbacks) {
        this.#callbacks = callbacks
        this.#bindControls()
    }

    #bindControls() {
        const searchInput = document.getElementById('library-search')
        const sortSelect = document.getElementById('library-sort')

        searchInput?.addEventListener('input', e => {
            this.#searchQuery = e.target.value.trim().toLowerCase()
            this.#renderGrid()
        })

        sortSelect?.addEventListener('change', e => {
            this.#sortBy = e.target.value
            this.#renderGrid()
        })

        document.getElementById('empty-browse-btn')?.addEventListener('click', () => {
            this.#callbacks.onBrowseFiles()
        })
    }

    #revokeCoverUrls() {
        for (const url of this.#coverUrls) URL.revokeObjectURL(url)
        this.#coverUrls = []
    }

    #makeCoverMarkup(book) {
        if (book.cover instanceof Blob && book.cover.size > 0) {
            const url = URL.createObjectURL(book.cover)
            this.#coverUrls.push(url)
            return `<img class="book-cover-img" src="${url}" alt="" loading="lazy">`
        }
        const palette = getCoverPalette(book.title)
        return `
            <div class="book-cover-fallback" style="background:${palette.bg};color:${palette.fg};--cover-accent:${palette.accent}">
                <div class="cover-rule"></div>
                <div class="cover-title">${escapeHtml(book.title || 'Untitled')}</div>
                ${book.author ? `<div class="cover-author">${escapeHtml(book.author)}</div>` : ''}
                <div class="cover-ornament"></div>
            </div>
        `
    }

    render(books) {
        this.#books = books || []
        this.#revokeCoverUrls()

        const emptyEl = document.getElementById('library-empty')
        const shelfEl = document.getElementById('library-shelf')

        if (!this.#books.length) {
            emptyEl.hidden = false
            shelfEl.hidden = true
            return
        }

        emptyEl.hidden = true
        shelfEl.hidden = false

        this.#renderContinueCard()
        this.#renderGrid()
    }

    #renderContinueCard() {
        const container = document.getElementById('continue-reading')
        const recent = [...this.#books].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0]
        if (!recent) {
            container.hidden = true
            return
        }

        container.hidden = false
        const pct = Math.round((recent.fraction || 0) * 100)
        const subtitle = [
            recent.chapterTitle,
            recent.lastOpenedAt ? `Read ${formatRelativeTime(recent.lastOpenedAt)}` : 'Added recently',
        ].filter(Boolean).join(' · ')

        container.innerHTML = `
            <div class="continue-card" data-open-id="${escapeHtml(recent.id)}" tabindex="0" role="button" aria-label="Continue reading ${escapeHtml(recent.title)}">
                <div class="continue-cover">
                    ${this.#makeCoverMarkup(recent)}
                    <div class="book-spine-sheen"></div>
                </div>
                <div class="continue-body">
                    <div class="continue-eyebrow">Continue</div>
                    <h2 class="continue-title">${escapeHtml(recent.title || 'Untitled Book')}</h2>
                    ${recent.author ? `<p class="continue-author">${escapeHtml(recent.author)}</p>` : ''}
                    <p class="continue-meta">${escapeHtml(subtitle)}</p>
                    <div class="continue-progress">
                        <div class="progress-track">
                            <div class="progress-fill" style="width:${pct}%"></div>
                        </div>
                        <span class="continue-pct">${pct}%</span>
                    </div>
                    <div class="continue-actions">
                        <span class="btn btn-primary btn-sm">Resume</span>
                        <span class="format-pill">${escapeHtml(recent.format || 'EPUB')}</span>
                    </div>
                </div>
            </div>
        `

        const card = container.querySelector('.continue-card')
        card?.addEventListener('click', () => this.#callbacks.onOpenBook(recent.id))
        card?.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                this.#callbacks.onOpenBook(recent.id)
            }
        })
    }

    #renderGrid() {
        const grid = document.getElementById('books-grid')
        const countEl = document.getElementById('library-count')

        let list = [...this.#books]
        if (this.#searchQuery) {
            const q = this.#searchQuery
            list = list.filter(b =>
                (b.title || '').toLowerCase().includes(q)
                || (b.author || '').toLowerCase().includes(q)
                || (b.format || '').toLowerCase().includes(q)
            )
        }

        switch (this.#sortBy) {
            case 'title':
                list.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
                break
            case 'author':
                list.sort((a, b) => (a.author || 'zzz').localeCompare(b.author || 'zzz'))
                break
            case 'added':
                list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
                break
            case 'progress':
                list.sort((a, b) => (b.fraction || 0) - (a.fraction || 0))
                break
            default:
                list.sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0))
        }

        if (countEl) {
            const total = this.#books.length
            countEl.textContent = list.length === total
                ? `${total} ${total === 1 ? 'book' : 'books'}`
                : `${list.length} of ${total}`
        }

        if (!list.length) {
            grid.innerHTML = `<div class="shelf-no-matches">No books match "${escapeHtml(this.#searchQuery)}".</div>`
            return
        }

        grid.innerHTML = list.map(book => {
            const pct = Math.round((book.fraction || 0) * 100)
            return `
                <article class="book-card" data-id="${escapeHtml(book.id)}">
                    <div class="book-cover-wrap" tabindex="0" role="button" aria-label="Open ${escapeHtml(book.title)}">
                        ${this.#makeCoverMarkup(book)}
                        <div class="book-spine-sheen"></div>
                        <span class="book-format-tag">${escapeHtml(book.format || 'EPUB')}</span>
                        <button class="book-delete-btn" type="button" data-delete-id="${escapeHtml(book.id)}" title="Remove from library" aria-label="Remove ${escapeHtml(book.title)}">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </button>
                        ${pct > 0 ? `
                        <div class="book-card-progress" title="${pct}% read">
                            <div class="book-card-progress-fill" style="width:${pct}%"></div>
                        </div>` : ''}
                    </div>
                    <div class="book-meta">
                        <h3 class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title || 'Untitled Book')}</h3>
                        <p class="book-author">${escapeHtml(book.author || 'Unknown Author')}</p>
                        <div class="book-submeta">
                            <span>${pct > 0 ? `${pct}%` : 'Unread'}</span>
                            <span>${escapeHtml(formatBytes(book.fileSize))}</span>
                        </div>
                    </div>
                </article>
            `
        }).join('')

        grid.querySelectorAll('.book-card').forEach(card => {
            const id = card.dataset.id
            const coverWrap = card.querySelector('.book-cover-wrap')
            const meta = card.querySelector('.book-meta')
            const delBtn = card.querySelector('.book-delete-btn')

            const open = () => this.#callbacks.onOpenBook(id)
            coverWrap?.addEventListener('click', e => {
                if (e.target.closest('.book-delete-btn')) return
                open()
            })
            coverWrap?.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    open()
                }
            })
            meta?.addEventListener('click', open)
            delBtn?.addEventListener('click', e => {
                e.stopPropagation()
                this.#callbacks.onDeleteBook(id)
            })
        })
    }
}
