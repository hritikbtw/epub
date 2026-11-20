import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import { buildBookCSS, HIGHLIGHT_COLORS, WIDTH_PRESETS } from './themes.js'

const debounce = (fn, wait = 120) => {
    let t
    return (...args) => {
        clearTimeout(t)
        t = setTimeout(() => fn(...args), wait)
    }
}

export class ContinuousScroller {
    #container
    #view
    #callbacks
    #settings
    #sections = [] // [{ bookIndex, section, wrapper, frameWrap, iframe, doc, overlayer, resizeObs, loaded, loadingPromise, size, startFrac, endFrac }]
    #sectionByBookIndex = new Map()
    #observer = null
    #scrollHandler = null
    #isProgrammaticScroll = false
    #currentBookIndex = 0
    #currentCfi = null
    #destroyed = false

    constructor(containerEl, view, settings, callbacks) {
        this.#container = containerEl
        this.#view = view
        this.#settings = settings
        this.#callbacks = callbacks
    }

    get currentBookIndex() {
        return this.#currentBookIndex
    }

    get currentCfi() {
        return this.#currentCfi
    }

    async open(startTarget = null) {
        const book = this.#view.book
        const linearSections = []
        let totalSize = 0
        book.sections.forEach((section, bookIndex) => {
            if (section.linear === 'no') return
            const size = Math.max(section.size || 1000, 500)
            linearSections.push({ bookIndex, section, size })
            totalSize += size
        })

        // Compute normalized fraction ranges per section
        let acc = 0
        this.#container.replaceChildren()
        const inner = document.createElement('div')
        inner.className = 'cscroll-column'
        this.#applyColumnWidth(inner)
        this.#container.append(inner)

        this.#sections = linearSections.map((item, pos) => {
            const startFrac = totalSize ? acc / totalSize : 0
            acc += item.size
            const endFrac = totalSize ? acc / totalSize : 1

            const wrapper = document.createElement('section')
            wrapper.className = 'cscroll-section'
            wrapper.dataset.bookIndex = String(item.bookIndex)

            if (pos > 0) {
                const divider = document.createElement('div')
                divider.className = 'cscroll-divider'
                wrapper.append(divider)
            }

            const frameWrap = document.createElement('div')
            frameWrap.className = 'cscroll-frame-wrap'
            // Reasonable placeholder height scaled lightly by byte size before lazy load
            const estHeight = Math.max(420, Math.min(2600, Math.round(item.size * 0.12)))
            frameWrap.style.minHeight = `${estHeight}px`
            wrapper.append(frameWrap)

            inner.append(wrapper)

            const entry = {
                bookIndex: item.bookIndex,
                section: item.section,
                wrapper,
                frameWrap,
                iframe: null,
                doc: null,
                overlayer: null,
                resizeObs: null,
                loaded: false,
                loadingPromise: null,
                size: item.size,
                startFrac,
                endFrac,
            }
            this.#sectionByBookIndex.set(item.bookIndex, entry)
            return entry
        })

        // Lazy load nearby sections as user scrolls
        this.#observer = new IntersectionObserver(entries => {
            for (const io of entries) {
                if (!io.isIntersecting) continue
                const idx = parseInt(io.target.dataset.bookIndex, 10)
                const sec = this.#sectionByBookIndex.get(idx)
                if (sec && !sec.loaded && !sec.loadingPromise) {
                    this.#loadSection(sec)
                }
            }
        }, {
            root: this.#container,
            rootMargin: '1400px 0px',
            threshold: 0,
        })

        for (const sec of this.#sections) {
            this.#observer.observe(sec.wrapper)
        }

        // Scroll tracking
        const reportScroll = debounce(() => {
            if (this.#destroyed || this.#isProgrammaticScroll) return
            this.#emitProgressFromScroll()
        }, 90)
        this.#scrollHandler = () => {
            if (this.#destroyed) return
            this.#callbacks.onScrollStart?.()
            reportScroll()
        }
        this.#container.addEventListener('scroll', this.#scrollHandler, { passive: true })

        // Navigate to starting target or first section
        if (startTarget != null) {
            await this.goTo(startTarget, false)
        } else if (this.#sections.length) {
            await this.#loadSection(this.#sections[0])
            if (this.#sections[1]) this.#loadSection(this.#sections[1])
            this.#emitProgressFromScroll()
        }
    }

    #applyColumnWidth(columnEl) {
        const preset = WIDTH_PRESETS[this.#settings.pageWidth] || WIDTH_PRESETS.medium
        columnEl.style.maxWidth = preset.maxInline
    }

    #makeIframeCSS() {
        return `
            ${buildBookCSS(this.#settings)}
            html, body {
                margin: 0 !important;
                padding: 0 !important;
                overflow: hidden !important;
                height: auto !important;
                min-height: 0 !important;
            }
            body {
                padding: 8px 0 24px !important;
            }
        `
    }

    async #loadSection(entry) {
        if (entry.loaded) return entry
        if (entry.loadingPromise) return entry.loadingPromise

        entry.loadingPromise = (async () => {
            try {
                const src = await entry.section.load()
                if (this.#destroyed || !src) return entry

                const iframe = document.createElement('iframe')
                iframe.className = 'cscroll-iframe'
                iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
                iframe.setAttribute('scrolling', 'no')
                iframe.style.width = '100%'
                iframe.style.border = '0'
                iframe.style.display = 'block'

                await new Promise(resolve => {
                    iframe.addEventListener('load', () => resolve(), { once: true })
                    iframe.src = src
                    entry.frameWrap.replaceChildren(iframe)
                })

                if (this.#destroyed) return entry
                const doc = iframe.contentDocument
                if (!doc) return entry

                entry.iframe = iframe
                entry.doc = doc
                entry.loaded = true

                // Inject styles
                const styleEl = doc.createElement('style')
                styleEl.dataset.folioStyle = 'true'
                styleEl.textContent = this.#makeIframeCSS()
                doc.head?.append(styleEl)

                // Setup Overlayer for highlights
                const overlayer = new Overlayer()
                doc.documentElement.style.position = 'relative'
                doc.body?.append(overlayer.element)
                entry.overlayer = overlayer

                // Height sync helper
                const syncHeight = () => {
                    if (this.#destroyed || !entry.doc?.documentElement) return
                    const h = Math.max(
                        entry.doc.documentElement.scrollHeight || 0,
                        entry.doc.body?.scrollHeight || 0,
                        120
                    )
                    iframe.style.height = `${h}px`
                    entry.frameWrap.style.minHeight = '0'
                    entry.overlayer?.redraw()
                }

                syncHeight()
                doc.fonts?.ready?.then(() => syncHeight())
                const ro = new ResizeObserver(() => syncHeight())
                ro.observe(doc.documentElement)
                if (doc.body) ro.observe(doc.body)
                entry.resizeObs = ro

                // Bind interactions inside iframe
                this.#bindIframeEvents(entry)

                // Draw saved highlights for this section
                this.#callbacks.onSectionReady?.(entry.bookIndex)

                return entry
            } catch (err) {
                console.warn(`ContinuousScroller failed to load section ${entry.bookIndex}`, err)
                return entry
            }
        })()

        return entry.loadingPromise
    }

    #bindIframeEvents(entry) {
        const { doc, bookIndex, overlayer } = entry
        const { book } = this.#view

        doc.addEventListener('keydown', e => this.#callbacks.onKeydown?.(e))

        // Link & footnote clicks
        doc.addEventListener('click', e => {
            const a = e.target.closest('a[href]')
            if (a) {
                e.preventDefault()
                const href_ = a.getAttribute('href')
                const href = entry.section?.resolveHref?.(href_) ?? href_
                if (book?.isExternal?.(href)) {
                    if (confirm(`Open external link?\n${href_}`)) {
                        window.open(href_, '_blank', 'noopener,noreferrer')
                    }
                } else {
                    const handled = this.#callbacks.onInternalLink?.({ a, href })
                    if (!handled) this.goTo(href)
                }
                return
            }

            // Existing highlight click
            const [hitKey, hitRange] = overlayer.hitTest(e)
            if (hitKey) {
                this.#callbacks.onShowAnnotation?.(hitKey, hitRange, doc)
                return
            }

            // General page click (close popovers or toggle focus)
            const sel = doc.getSelection()
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return
            this.#callbacks.onPageClick?.(e)
        })

        // Text selection
        const onSelectEnd = () => {
            requestAnimationFrame(() => {
                const sel = doc.getSelection()
                if (!sel || sel.isCollapsed || !sel.rangeCount) {
                    this.#callbacks.onSelectionCleared?.()
                    return
                }
                const text = sel.toString().replace(/\s+/g, ' ').trim()
                if (!text) {
                    this.#callbacks.onSelectionCleared?.()
                    return
                }
                const range = sel.getRangeAt(0).cloneRange()
                const cfi = this.#view.getCFI(bookIndex, range)
                if (cfi) {
                    this.#callbacks.onSelection?.({ text, cfi, range, doc, index: bookIndex })
                }
            })
        }
        doc.addEventListener('mouseup', onSelectEnd)
        doc.addEventListener('touchend', () => setTimeout(onSelectEnd, 60))
    }

    updateStyles(settings) {
        this.#settings = settings
        const col = this.#container.querySelector('.cscroll-column')
        if (col) this.#applyColumnWidth(col)

        const css = this.#makeIframeCSS()
        for (const entry of this.#sections) {
            if (!entry.loaded || !entry.doc) continue
            let styleEl = entry.doc.querySelector('style[data-folio-style]')
            if (!styleEl) {
                styleEl = entry.doc.createElement('style')
                styleEl.dataset.folioStyle = 'true'
                entry.doc.head?.append(styleEl)
            }
            styleEl.textContent = css
            requestAnimationFrame(() => {
                if (!entry.doc?.documentElement || !entry.iframe) return
                const h = Math.max(
                    entry.doc.documentElement.scrollHeight || 0,
                    entry.doc.body?.scrollHeight || 0,
                    120
                )
                entry.iframe.style.height = `${h}px`
                entry.overlayer?.redraw()
            })
        }
    }

    async goTo(target, smooth = false) {
        const resolved = await this.#view.resolveNavigation(target)
        if (!resolved) return
        const entry = this.#sectionByBookIndex.get(resolved.index) || this.#sections[0]
        if (!entry) return

        this.#isProgrammaticScroll = true
        try {
            await this.#loadSection(entry)
            // Preload adjacent sections so scrolling immediately works in both directions
            const pos = this.#sections.indexOf(entry)
            if (pos > 0) this.#loadSection(this.#sections[pos - 1])
            if (pos < this.#sections.length - 1) this.#loadSection(this.#sections[pos + 1])

            // Wait a frame for iframe height to settle
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

            let extraOffset = 0
            if (typeof resolved.anchor === 'function' && entry.doc) {
                try {
                    const anchored = resolved.anchor(entry.doc)
                    if (anchored instanceof Range) {
                        const rect = anchored.getBoundingClientRect()
                        extraOffset = Math.max(0, rect.top - 48)
                    } else if (anchored && anchored.getBoundingClientRect) {
                        const rect = anchored.getBoundingClientRect()
                        extraOffset = Math.max(0, rect.top - 48)
                    }
                } catch {
                    // fallback to section top
                }
            } else if (typeof resolved.anchor === 'number') {
                extraOffset = resolved.anchor * (entry.iframe?.offsetHeight || 0)
            }

            const top = entry.wrapper.offsetTop + extraOffset
            this.#container.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
            this.#currentBookIndex = entry.bookIndex
        } finally {
            setTimeout(() => {
                this.#isProgrammaticScroll = false
                if (!this.#destroyed) this.#emitProgressFromScroll()
            }, smooth ? 380 : 100)
        }
    }

    async goToFraction(frac) {
        const clamped = Math.max(0, Math.min(1, frac))
        const entry = this.#sections.find(s => clamped >= s.startFrac && clamped <= s.endFrac)
            || this.#sections[this.#sections.length - 1]
        if (!entry) return
        const span = Math.max(0.0001, entry.endFrac - entry.startFrac)
        const localFrac = Math.max(0, Math.min(1, (clamped - entry.startFrac) / span))

        this.#isProgrammaticScroll = true
        try {
            await this.#loadSection(entry)
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
            const top = entry.wrapper.offsetTop + localFrac * Math.max(0, entry.wrapper.offsetHeight - this.#container.clientHeight * 0.5)
            this.#container.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
            this.#currentBookIndex = entry.bookIndex
        } finally {
            setTimeout(() => {
                this.#isProgrammaticScroll = false
                if (!this.#destroyed) this.#emitProgressFromScroll()
            }, 100)
        }
    }

    async addAnnotation(ann) {
        if (!ann?.cfi) return
        try {
            const resolved = await this.#view.resolveNavigation(ann.cfi)
            if (!resolved) return
            const entry = this.#sectionByBookIndex.get(resolved.index)
            if (!entry?.loaded || !entry.doc || !entry.overlayer) return
            const range = typeof resolved.anchor === 'function' ? resolved.anchor(entry.doc) : null
            if (!range) return
            const colorInfo = HIGHLIGHT_COLORS[ann.color] || HIGHLIGHT_COLORS.blue
            entry.overlayer.add(ann.cfi, range, Overlayer.highlight, { color: colorInfo.hex })
        } catch {
            // ignore unresolvable CFI
        }
    }

    deleteAnnotation(cfi) {
        for (const entry of this.#sections) {
            entry.overlayer?.remove(cfi)
        }
    }

    deselect() {
        for (const entry of this.#sections) {
            entry.doc?.defaultView?.getSelection()?.removeAllRanges()
        }
    }

    #emitProgressFromScroll() {
        if (!this.#sections.length) return
        const scrollTop = this.#container.scrollTop
        const probeY = scrollTop + 100

        let active = this.#sections[0]
        for (const sec of this.#sections) {
            if (sec.wrapper.offsetTop <= probeY) active = sec
            else break
        }

        const height = Math.max(1, active.wrapper.offsetHeight)
        const localFrac = Math.max(0, Math.min(1, (probeY - active.wrapper.offsetTop) / height))
        const fraction = active.startFrac + localFrac * (active.endFrac - active.startFrac)

        this.#currentBookIndex = active.bookIndex
        const cfi = active.section.cfi || this.#view.getCFI(active.bookIndex)
        this.#currentCfi = cfi

        const progressInfo = this.#view.getProgressOf(active.bookIndex) || {}
        this.#callbacks.onRelocate?.({
            fraction: Math.max(0, Math.min(1, fraction)),
            tocItem: progressInfo.tocItem,
            pageItem: progressInfo.pageItem,
            cfi,
            index: active.bookIndex,
            sectionPos: this.#sections.indexOf(active),
            sectionCount: this.#sections.length,
        })
    }

    destroy() {
        this.#destroyed = true
        this.#observer?.disconnect()
        this.#observer = null
        if (this.#scrollHandler) {
            this.#container.removeEventListener('scroll', this.#scrollHandler)
            this.#scrollHandler = null
        }
        for (const entry of this.#sections) {
            entry.resizeObs?.disconnect()
        }
        this.#sections = []
        this.#sectionByBookIndex.clear()
        this.#container.replaceChildren()
    }
}
