import '../vendor/foliate-js/view.js'
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import { FootnoteHandler } from '../vendor/foliate-js/footnotes.js'
import { ContinuousScroller } from './continuous-scroll.js'
import {
    THEMES, HIGHLIGHT_COLORS, FONTS, WIDTH_PRESETS,
    buildBookCSS, applyAppTheme, saveSettings,
} from './themes.js'
import {
    getAnnotations, saveAnnotation, deleteAnnotation, updateBookProgress,
} from './db.js'
import {
    escapeHtml, debounce, uid, formatBytes, exportNotesMarkdown, stripHtmlTags,
} from './utils.js'

const percentFmt = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 })

const LEGACY_COLOR_MAP = { amber: 'gold', sage: 'green', sky: 'blue', rose: 'rose' }
const resolveHighlightColor = id => HIGHLIGHT_COLORS[id] || HIGHLIGHT_COLORS[LEGACY_COLOR_MAP[id]] || HIGHLIGHT_COLORS.blue

const isBareChapterNumber = label => {
    const s = (label || '').trim()
    if (!s) return true
    return /^(?:chapter|ch\.?|part|section|book)?\s*(?:\d+|[ivxlcdm]+)\.?:?$/i.test(s)
}

export class ReaderController {
    view = null
    scroller = null
    bookRecord = null
    settings
    #callbacks
    #annotations = []
    #annotationsByCfi = new Map()
    #activeSelection = null
    #activeAnnotation = null
    #currentLocation = null
    #footnoteHandler = new FootnoteHandler()
    #footnoteView = null
    #footnoteHref = null
    #searchToken = 0
    #tocAnchors = new Map()
    #tocFlat = []
    #segments = [] // [{ startFrac, endFrac, label, href, bookIndex }]
    #drawerOpen = false
    #activeTab = 'toc'
    #focusMode = false
    #coverObjectUrl = null
    #boundKeydown
    #boundDocClick
    #saveProgressDebounced

    constructor(settings, callbacks) {
        this.settings = settings
        this.#callbacks = callbacks
        this.#boundKeydown = this.#onKeydown.bind(this)
        this.#boundDocClick = this.#onGlobalClick.bind(this)
        this.#saveProgressDebounced = debounce(() => this.#persistProgress(), 600)

        this.#initStaticUI()
        this.#initFootnotes()
    }

    get isContinuousMode() {
        return !!this.scroller && this.settings.layout === 'scrolled' && !this.view?.isFixedLayout
    }

    #initStaticUI() {
        // Header buttons
        document.getElementById('back-library-btn')?.addEventListener('click', () => {
            this.#callbacks.onCloseReader()
        })
        document.getElementById('drawer-toggle-btn')?.addEventListener('click', () => {
            this.toggleDrawer()
        })
        document.getElementById('drawer-close-btn')?.addEventListener('click', () => {
            this.closeDrawer()
        })
        document.getElementById('drawer-backdrop')?.addEventListener('click', () => {
            this.closeDrawer()
        })
        document.getElementById('history-back-btn')?.addEventListener('click', () => {
            this.view?.history.back()
        })
        document.getElementById('history-fwd-btn')?.addEventListener('click', () => {
            this.view?.history.forward()
        })
        document.getElementById('bookmark-btn')?.addEventListener('click', () => {
            this.#toggleBookmark()
        })
        document.getElementById('search-open-btn')?.addEventListener('click', () => {
            this.openDrawer('search')
        })
        document.getElementById('appearance-btn')?.addEventListener('click', e => {
            e.stopPropagation()
            this.#toggleAppearancePopover()
        })
        document.getElementById('book-info-btn')?.addEventListener('click', () => {
            this.#openBookInfoModal()
        })
        document.getElementById('fullscreen-btn')?.addEventListener('click', () => {
            this.#toggleFullscreen()
        })

        // Edge page turn buttons (paginated mode)
        document.getElementById('prev-page-btn')?.addEventListener('click', () => this.view?.goLeft())
        document.getElementById('next-page-btn')?.addEventListener('click', () => this.view?.goRight())

        // Bottom dock chapter prev/next buttons
        document.getElementById('prev-chapter-btn')?.addEventListener('click', () => this.#stepChapter(-1))
        document.getElementById('next-chapter-btn')?.addEventListener('click', () => this.#stepChapter(1))

        // Segmented chapter map interaction
        this.#initChapterMap()

        // Drawer tabs
        document.querySelectorAll('.drawer-tab').forEach(btn => {
            btn.addEventListener('click', () => this.#setDrawerTab(btn.dataset.tab))
        })

        // Export notes
        document.getElementById('export-notes-btn')?.addEventListener('click', () => {
            this.#exportNotes()
        })

        // Search form
        const searchForm = document.getElementById('book-search-form')
        const searchInput = document.getElementById('book-search-input')
        const searchClear = document.getElementById('book-search-clear')
        searchForm?.addEventListener('submit', e => {
            e.preventDefault()
            this.#runSearch(searchInput.value.trim())
        })
        searchClear?.addEventListener('click', () => {
            searchInput.value = ''
            this.#clearSearch()
            searchInput.focus()
        })

        // Appearance, Selection, Annotation
        this.#initAppearanceControls()
        this.#initSelectionPopover()
        this.#initAnnotationPopover()

        // Footnote card controls
        document.getElementById('footnote-close-btn')?.addEventListener('click', () => {
            this.#closeFootnote()
        })
        document.getElementById('footnote-goto-btn')?.addEventListener('click', () => {
            if (this.#footnoteHref) {
                const href = this.#footnoteHref
                this.#closeFootnote()
                this.#navigateTo(href)
            }
        })
    }

    #initChapterMap() {
        const mapEl = document.getElementById('chapter-map')
        const tooltip = document.getElementById('chapter-map-tooltip')
        if (!mapEl) return

        const fracFromEvent = e => {
            const rect = mapEl.getBoundingClientRect()
            return Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)))
        }

        const updateTooltip = e => {
            if (!tooltip || !this.view) return
            const rect = mapEl.getBoundingClientRect()
            const frac = fracFromEvent(e)
            const seg = this.#findSegmentAtFraction(frac)
            const pct = percentFmt.format(frac)
            tooltip.textContent = seg?.label ? `${seg.label} · ${pct}` : pct
            const x = Math.max(12, Math.min(rect.width - 12, e.clientX - rect.left))
            tooltip.style.left = `${x}px`
            tooltip.hidden = false
        }

        let dragging = false
        mapEl.addEventListener('pointerdown', e => {
            if (!this.view) return
            dragging = true
            mapEl.setPointerCapture?.(e.pointerId)
            const frac = fracFromEvent(e)
            this.#updateProgressBars(frac)
            this.#goToFraction(frac)
            updateTooltip(e)
        })
        mapEl.addEventListener('pointermove', e => {
            updateTooltip(e)
            if (!dragging || !this.view) return
            const frac = fracFromEvent(e)
            this.#updateProgressBars(frac)
            this.#goToFraction(frac)
        })
        mapEl.addEventListener('pointerup', () => { dragging = false })
        mapEl.addEventListener('pointercancel', () => { dragging = false })
        mapEl.addEventListener('mouseleave', () => {
            dragging = false
            if (tooltip) tooltip.hidden = true
        })

        mapEl.addEventListener('keydown', e => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault()
                this.#stepChapter(-1)
            } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                this.#stepChapter(1)
            }
        })
    }

    #initAppearanceControls() {
        const swatchBox = document.getElementById('theme-swatches')
        if (swatchBox) {
            swatchBox.innerHTML = Object.values(THEMES).map(t => `
                <button type="button" class="theme-swatch" data-theme-id="${t.id}" title="${t.name}">
                    <span class="swatch-tile" style="background:${t.swatchBg};border-color:${t.swatchRing}">
                        <span class="swatch-bar" style="background:${t.accent}"></span>
                    </span>
                    <span class="swatch-label">${t.name}</span>
                </button>
            `).join('')
            swatchBox.querySelectorAll('.theme-swatch').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.updateSettings({ theme: btn.dataset.themeId })
                })
            })
        }

        const fontBox = document.getElementById('font-options')
        if (fontBox) {
            fontBox.innerHTML = Object.values(FONTS).map(f => `
                <button type="button" class="font-chip" data-font-id="${f.id}">
                    <span class="font-chip-sample" style="font-family:${f.previewStack}">${f.sample}</span>
                    <span class="font-chip-name">${f.name}</span>
                </button>
            `).join('')
            fontBox.querySelectorAll('.font-chip').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.updateSettings({ fontFamily: btn.dataset.fontId })
                })
            })
        }

        document.querySelectorAll('[data-layout-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.updateSettings({ layout: btn.dataset.layoutMode })
            })
        })

        document.querySelectorAll('[data-page-width]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.updateSettings({ pageWidth: btn.dataset.pageWidth })
            })
        })

        const sizeSlider = document.getElementById('font-size-slider')
        document.getElementById('font-size-dec')?.addEventListener('click', () => {
            this.updateSettings({ fontSize: Math.max(13, this.settings.fontSize - 1) })
        })
        document.getElementById('font-size-inc')?.addEventListener('click', () => {
            this.updateSettings({ fontSize: Math.min(28, this.settings.fontSize + 1) })
        })
        sizeSlider?.addEventListener('input', e => {
            this.updateSettings({ fontSize: parseInt(e.target.value, 10) })
        })

        const lhSlider = document.getElementById('line-height-slider')
        lhSlider?.addEventListener('input', e => {
            this.updateSettings({ lineHeight: parseFloat(e.target.value) })
        })

        document.getElementById('toggle-justify')?.addEventListener('change', e => {
            this.updateSettings({ justify: e.target.checked })
        })
        document.getElementById('toggle-hyphenate')?.addEventListener('change', e => {
            this.updateSettings({ hyphenate: e.target.checked })
        })
        document.getElementById('toggle-override')?.addEventListener('change', e => {
            this.updateSettings({ overrideStyles: e.target.checked })
        })

        this.#syncAppearanceUI()
    }

    #syncAppearanceUI() {
        const s = this.settings
        document.querySelectorAll('.theme-swatch').forEach(el => {
            el.classList.toggle('active', el.dataset.themeId === s.theme)
        })
        document.querySelectorAll('.font-chip').forEach(el => {
            el.classList.toggle('active', el.dataset.fontId === s.fontFamily)
        })
        document.querySelectorAll('[data-layout-mode]').forEach(el => {
            el.classList.toggle('active', el.dataset.layoutMode === s.layout)
        })
        document.querySelectorAll('[data-page-width]').forEach(el => {
            el.classList.toggle('active', el.dataset.pageWidth === s.pageWidth)
        })
        const sizeVal = document.getElementById('font-size-value')
        const sizeSlider = document.getElementById('font-size-slider')
        if (sizeVal) sizeVal.textContent = `${s.fontSize}px`
        if (sizeSlider) sizeSlider.value = String(s.fontSize)

        const lhVal = document.getElementById('line-height-value')
        const lhSlider = document.getElementById('line-height-slider')
        if (lhVal) lhVal.textContent = s.lineHeight.toFixed(2)
        if (lhSlider) lhSlider.value = String(s.lineHeight)

        const jEl = document.getElementById('toggle-justify')
        const hEl = document.getElementById('toggle-hyphenate')
        const oEl = document.getElementById('toggle-override')
        if (jEl) jEl.checked = !!s.justify
        if (hEl) hEl.checked = !!s.hyphenate
        if (oEl) oEl.checked = !!s.overrideStyles
    }

    async updateSettings(patch) {
        const prevLayout = this.settings.layout
        Object.assign(this.settings, patch)
        saveSettings(this.settings)
        applyAppTheme(this.settings.theme)
        this.#syncAppearanceUI()

        if (this.view && !this.view.isFixedLayout) {
            const layoutChanged = patch.layout && patch.layout !== prevLayout
            const wantContinuous = this.settings.layout === 'scrolled'

            if (layoutChanged && wantContinuous && !this.scroller) {
                await this.#activateContinuousScroll(this.#currentLocation?.cfi || this.#currentLocation?.fraction || 0)
            } else if (layoutChanged && !wantContinuous && this.scroller) {
                const resumeTarget = this.scroller.currentCfi || this.scroller.currentBookIndex
                this.#deactivateContinuousScroll()
                this.#applyPaginatorStyles()
                if (resumeTarget != null) {
                    await this.view.goTo(resumeTarget)
                }
            } else if (this.isContinuousMode) {
                this.scroller.updateStyles(this.settings)
            } else {
                this.#applyPaginatorStyles()
            }
        }

        if (this.#footnoteView && !this.#footnoteView.isFixedLayout) {
            this.#footnoteView.renderer?.setStyles?.(
                buildBookCSS({ ...this.settings, fontSize: Math.max(14, this.settings.fontSize - 2) })
            )
        }
    }

    #applyPaginatorStyles() {
        if (!this.view || !this.view.renderer || this.view.isFixedLayout) return
        const renderer = this.view.renderer
        const s = this.settings
        const widthPreset = WIDTH_PRESETS[s.pageWidth] || WIDTH_PRESETS.medium

        renderer.setAttribute('flow', 'paginated')
        renderer.setAttribute('max-column-count', s.layout === 'single' ? '1' : '2')
        renderer.setAttribute('max-inline-size', widthPreset.maxInline)
        renderer.setAttribute('gap', '7%')
        renderer.setAttribute('margin', '44px')
        renderer.setAttribute('animated', '')
        renderer.setStyles?.(buildBookCSS(s))

        document.getElementById('reader-view')?.classList.remove('is-scrolled')
        this.#updateRunningMarginals()
    }

    async #activateContinuousScroll(startTarget) {
        if (!this.view || this.view.isFixedLayout) return
        const contEl = document.getElementById('continuous-stage')
        if (!contEl) return

        this.view.hidden = true
        contEl.hidden = false
        document.getElementById('reader-view')?.classList.add('is-scrolled')

        this.scroller?.destroy()
        this.scroller = new ContinuousScroller(contEl, this.view, this.settings, {
            onRelocate: detail => this.#onRelocate(detail),
            onSectionReady: bookIndex => this.#drawHighlightsForContinuous(bookIndex),
            onSelection: sel => {
                this.#activeSelection = sel
                this.#showSelectionPopover(sel.doc, sel.range)
            },
            onSelectionCleared: () => this.#hideSelectionPopover(),
            onShowAnnotation: (cfi, range, doc) => {
                const ann = this.#annotationsByCfi.get(cfi)
                if (ann) this.#openAnnotationPopover(ann, range, doc)
            },
            onInternalLink: ({ a, href }) => {
                let prevented = false
                const fakeEvent = {
                    detail: { a, href },
                    preventDefault: () => { prevented = true },
                }
                this.#footnoteHandler.handle(this.view.book, fakeEvent)
                return prevented
            },
            onPageClick: () => {
                if (!document.getElementById('appearance-popover')?.hidden) return this.#closeAppearancePopover()
                if (!document.getElementById('annotation-popover')?.hidden) return this.#hideAnnotationPopover()
                if (!document.getElementById('footnote-card')?.hidden) return this.#closeFootnote()
                this.#setFocusMode(!this.#focusMode)
            },
            onScrollStart: () => {
                this.#hideSelectionPopover()
            },
            onKeydown: e => this.#onKeydown(e),
        })

        await this.scroller.open(startTarget)
    }

    #deactivateContinuousScroll() {
        this.scroller?.destroy()
        this.scroller = null
        const contEl = document.getElementById('continuous-stage')
        if (contEl) contEl.hidden = true
        if (this.view) this.view.hidden = false
        document.getElementById('reader-view')?.classList.remove('is-scrolled')
    }

    #drawHighlightsForContinuous() {
        if (!this.scroller) return
        for (const ann of this.#annotations) {
            if (ann.type === 'highlight' && ann.cfi) {
                this.scroller.addAnnotation(ann)
            }
        }
    }

    async #navigateTo(target) {
        if (this.isContinuousMode) {
            await this.scroller.goTo(target, false)
        } else {
            await this.view?.goTo(target)
        }
    }

    async #goToFraction(frac) {
        if (this.isContinuousMode) {
            await this.scroller.goToFraction(frac)
        } else {
            await this.view?.goToFraction(frac)
        }
    }

    #initSelectionPopover() {
        const pop = document.getElementById('selection-popover')
        if (!pop) return

        const colorsEl = pop.querySelector('.selection-colors')
        if (colorsEl) {
            colorsEl.innerHTML = Object.values(HIGHLIGHT_COLORS).map(c => `
                <button type="button" class="hl-dot" data-hl-color="${c.id}" style="--dot-color:${c.swatch}" title="Highlight ${c.name}" aria-label="Highlight ${c.name}"></button>
            `).join('')
            colorsEl.querySelectorAll('.hl-dot').forEach(btn => {
                btn.addEventListener('click', e => {
                    e.stopPropagation()
                    this.#createHighlightFromSelection(btn.dataset.hlColor, false)
                })
            })
        }

        document.getElementById('sel-note-btn')?.addEventListener('click', e => {
            e.stopPropagation()
            this.#createHighlightFromSelection('blue', true)
        })
        document.getElementById('sel-copy-btn')?.addEventListener('click', async e => {
            e.stopPropagation()
            if (!this.#activeSelection?.text) return
            try {
                await navigator.clipboard.writeText(this.#activeSelection.text)
                this.#callbacks.onToast('Quote copied to clipboard')
            } catch {
                this.#callbacks.onToast('Could not copy to clipboard')
            }
            this.#hideSelectionPopover()
            this.#deselectAll()
        })
        document.getElementById('sel-search-btn')?.addEventListener('click', e => {
            e.stopPropagation()
            const q = this.#activeSelection?.text?.slice(0, 80)?.trim()
            this.#hideSelectionPopover()
            this.#deselectAll()
            if (q) {
                this.openDrawer('search')
                const input = document.getElementById('book-search-input')
                if (input) input.value = q
                this.#runSearch(q)
            }
        })
    }

    #deselectAll() {
        this.view?.deselect()
        this.scroller?.deselect()
    }

    #initAnnotationPopover() {
        const pop = document.getElementById('annotation-popover')
        if (!pop) return

        const colorsEl = pop.querySelector('.ann-colors')
        if (colorsEl) {
            colorsEl.innerHTML = Object.values(HIGHLIGHT_COLORS).map(c => `
                <button type="button" class="hl-dot" data-ann-color="${c.id}" style="--dot-color:${c.swatch}" title="${c.name}" aria-label="${c.name}"></button>
            `).join('')
            colorsEl.querySelectorAll('.hl-dot').forEach(btn => {
                btn.addEventListener('click', async e => {
                    e.stopPropagation()
                    if (!this.#activeAnnotation) return
                    this.#activeAnnotation.color = btn.dataset.annColor
                    await saveAnnotation(this.#activeAnnotation)
                    this.view?.addAnnotation({ value: this.#activeAnnotation.cfi, ...this.#activeAnnotation })
                    this.scroller?.addAnnotation(this.#activeAnnotation)
                    this.#renderNotesTab()
                    colorsEl.querySelectorAll('.hl-dot').forEach(d => d.classList.toggle('active', d === btn))
                })
            })
        }

        document.getElementById('ann-save-btn')?.addEventListener('click', async e => {
            e.stopPropagation()
            if (!this.#activeAnnotation) return
            const noteInput = document.getElementById('ann-note-input')
            this.#activeAnnotation.note = noteInput.value.trim()
            await saveAnnotation(this.#activeAnnotation)
            this.#renderNotesTab()
            this.#hideAnnotationPopover()
            this.#callbacks.onToast('Note saved')
        })

        document.getElementById('ann-copy-btn')?.addEventListener('click', async e => {
            e.stopPropagation()
            if (!this.#activeAnnotation?.text) return
            try {
                await navigator.clipboard.writeText(this.#activeAnnotation.text)
                this.#callbacks.onToast('Highlight copied')
            } catch {
                // ignore
            }
        })

        document.getElementById('ann-delete-btn')?.addEventListener('click', async e => {
            e.stopPropagation()
            if (!this.#activeAnnotation) return
            const ann = this.#activeAnnotation
            this.#hideAnnotationPopover()
            await this.#removeAnnotation(ann)
        })

        document.getElementById('ann-close-btn')?.addEventListener('click', e => {
            e.stopPropagation()
            this.#hideAnnotationPopover()
        })
    }

    #initFootnotes() {
        this.#footnoteHandler.addEventListener('before-render', e => {
            const { view } = e.detail
            this.#closeFootnote()
            this.#footnoteView = view
            const card = document.getElementById('footnote-card')
            const body = document.getElementById('footnote-body')
            if (card && body) {
                body.replaceChildren(view)
                card.hidden = false
            }
            view.renderer.setAttribute('flow', 'scrolled')
            view.renderer.setAttribute('margin', '16px')
            view.renderer.setStyles?.(buildBookCSS({ ...this.settings, fontSize: Math.max(14, this.settings.fontSize - 2) }))
        })
        this.#footnoteHandler.addEventListener('render', e => {
            const { href } = e.detail
            this.#footnoteHref = href
            const card = document.getElementById('footnote-card')
            if (card) {
                card.hidden = false
                requestAnimationFrame(() => card.classList.add('open'))
            }
        })
    }

    #closeFootnote() {
        const card = document.getElementById('footnote-card')
        const body = document.getElementById('footnote-body')
        if (card) {
            card.classList.remove('open')
            card.hidden = true
        }
        if (this.#footnoteView) {
            this.#footnoteView.close()
            this.#footnoteView = null
        }
        if (body) body.replaceChildren()
        this.#footnoteHref = null
    }

    async open(bookRecord) {
        this.close()
        this.bookRecord = bookRecord

        const stage = document.getElementById('reader-stage')
        const loading = document.getElementById('reader-loading')
        if (loading) loading.hidden = false

        this.#setFocusMode(false)
        this.#hideSelectionPopover()
        this.#hideAnnotationPopover()
        this.#closeFootnote()
        this.#closeAppearancePopover()

        const view = document.createElement('foliate-view')
        view.id = 'foliate-view-el'
        this.view = view

        this.#annotations = bookRecord.id ? await getAnnotations(bookRecord.id) : []
        this.#rebuildAnnotationMap()

        view.addEventListener('load', e => this.#onSectionLoad(e.detail))
        view.addEventListener('relocate', e => {
            if (!this.isContinuousMode) this.#onRelocate(e.detail)
        })
        view.addEventListener('link', e => {
            this.#footnoteHandler.handle(view.book, e)
        })
        view.addEventListener('external-link', e => {
            e.preventDefault()
            if (confirm(`Open external link?\n${e.detail.href_}`)) {
                window.open(e.detail.href_, '_blank', 'noopener,noreferrer')
            }
        })
        view.addEventListener('create-overlay', () => {
            this.#drawAllHighlights()
        })
        view.addEventListener('draw-annotation', e => {
            const { draw, annotation } = e.detail
            const colorInfo = resolveHighlightColor(annotation.color)
            draw(Overlayer.highlight, { color: colorInfo.hex })
        })
        view.addEventListener('show-annotation', e => {
            const { value, range } = e.detail
            const ann = this.#annotationsByCfi.get(value)
            if (ann) this.#openAnnotationPopover(ann, range)
        })
        view.history.addEventListener('index-change', () => this.#updateHistoryButtons())

        stage.querySelector('foliate-view')?.remove()
        stage.prepend(view)

        try {
            await view.open(bookRecord.file)

            view.book.transformTarget?.addEventListener('data', ({ detail }) => {
                detail.data = Promise.resolve(detail.data).catch(err => {
                    console.warn(`Failed to load resource ${detail.name}`, err)
                    return ''
                })
            })

            const title = bookRecord.title || 'Untitled Book'
            document.title = `${title} — Folio`
            document.getElementById('reader-book-title').textContent = title
            document.getElementById('reader-chapter-title').textContent = ''
            document.getElementById('drawer-book-title').textContent = title
            document.getElementById('drawer-book-author').textContent = bookRecord.author || ''

            const drawerCover = document.getElementById('drawer-book-cover')
            if (this.#coverObjectUrl) URL.revokeObjectURL(this.#coverObjectUrl)
            this.#coverObjectUrl = null
            if (bookRecord.cover instanceof Blob && bookRecord.cover.size > 0) {
                this.#coverObjectUrl = URL.createObjectURL(bookRecord.cover)
                drawerCover.src = this.#coverObjectUrl
                drawerCover.hidden = false
            } else {
                drawerCover.removeAttribute('src')
                drawerCover.hidden = true
            }

            // Build TOC & Segmented Chapter Map
            this.#renderTOC(view.book.toc || [])
            this.#buildChapterSegments()
            this.#renderNotesTab()
            this.#clearSearch()

            // Start in either Continuous Scroll or Paginated mode
            if (this.settings.layout === 'scrolled' && !view.isFixedLayout) {
                this.#applyPaginatorStyles()
                await this.#activateContinuousScroll(bookRecord.lastCfi || 0)
            } else {
                this.#deactivateContinuousScroll()
                this.#applyPaginatorStyles()
                await view.init({
                    lastLocation: bookRecord.lastCfi || null,
                    showTextStart: true,
                })
            }

            if (bookRecord.id) {
                await updateBookProgress(bookRecord.id, { lastOpenedAt: Date.now() })
            }

            document.addEventListener('keydown', this.#boundKeydown)
            document.addEventListener('click', this.#boundDocClick)
            this.#updateHistoryButtons()
        } finally {
            if (loading) loading.hidden = true
        }
    }

    close() {
        document.removeEventListener('keydown', this.#boundKeydown)
        document.removeEventListener('click', this.#boundDocClick)
        this.#closeFootnote()
        this.#hideSelectionPopover()
        this.#hideAnnotationPopover()
        this.#closeAppearancePopover()
        this.closeDrawer()
        this.#deactivateContinuousScroll()
        this.#searchToken++
        if (this.view) {
            this.view.close()
            this.view.remove()
            this.view = null
        }
        if (this.#coverObjectUrl) {
            URL.revokeObjectURL(this.#coverObjectUrl)
            this.#coverObjectUrl = null
        }
        this.bookRecord = null
        this.#currentLocation = null
        this.#annotations = []
        this.#annotationsByCfi.clear()
        this.#segments = []
        document.title = 'Folio'
    }

    #rebuildAnnotationMap() {
        this.#annotationsByCfi.clear()
        for (const a of this.#annotations) {
            if (a.type === 'highlight' && a.cfi) {
                this.#annotationsByCfi.set(a.cfi, a)
            }
        }
    }

    #drawAllHighlights() {
        if (!this.view) return
        for (const ann of this.#annotations) {
            if (ann.type === 'highlight' && ann.cfi) {
                this.view.addAnnotation({ value: ann.cfi, ...ann }).catch(() => {})
            }
        }
    }

    #onSectionLoad({ doc, index }) {
        doc.addEventListener('keydown', this.#boundKeydown)

        const handleSelectEnd = () => {
            requestAnimationFrame(() => {
                const sel = doc.getSelection()
                if (!sel || sel.isCollapsed || !sel.rangeCount) {
                    this.#hideSelectionPopover()
                    return
                }
                const text = sel.toString().replace(/\s+/g, ' ').trim()
                if (!text) {
                    this.#hideSelectionPopover()
                    return
                }
                const range = sel.getRangeAt(0).cloneRange()
                const cfi = this.view?.getCFI(index, range)
                if (!cfi) return
                this.#activeSelection = { text, cfi, range, doc, index }
                this.#showSelectionPopover(doc, range)
            })
        }

        doc.addEventListener('mouseup', handleSelectEnd)
        doc.addEventListener('touchend', () => setTimeout(handleSelectEnd, 60))

        doc.addEventListener('click', e => {
            if (!document.getElementById('appearance-popover')?.hidden) return this.#closeAppearancePopover()
            if (!document.getElementById('annotation-popover')?.hidden) return this.#hideAnnotationPopover()
            if (!document.getElementById('footnote-card')?.hidden) return this.#closeFootnote()

            if (e.target.closest('a, button, input, textarea, select, summary, video, audio')) return
            const sel = doc.getSelection()
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return

            const frame = doc.defaultView?.frameElement
            const frameRect = frame ? frame.getBoundingClientRect() : { left: 0 }
            const screenX = frameRect.left + e.clientX
            const stageRect = document.getElementById('reader-stage')?.getBoundingClientRect()
                || { left: 0, width: window.innerWidth }
            const relX = (screenX - stageRect.left) / Math.max(1, stageRect.width)

            if (!this.isContinuousMode) {
                if (relX < 0.16) {
                    this.view?.goLeft()
                    return
                }
                if (relX > 0.84) {
                    this.view?.goRight()
                    return
                }
            }
            this.#setFocusMode(!this.#focusMode)
        })

        let wheelCooldown = 0
        doc.addEventListener('wheel', e => {
            if (this.isContinuousMode || this.view?.isFixedLayout) return
            const now = Date.now()
            if (now - wheelCooldown < 240) return
            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
            if (Math.abs(delta) < 28) return
            wheelCooldown = now
            if (delta > 0) this.view?.next()
            else this.view?.prev()
        }, { passive: true })
    }

    #onRelocate(detail) {
        this.#currentLocation = detail
        this.#hideSelectionPopover()
        this.#hideAnnotationPopover()

        const fraction = typeof detail.fraction === 'number' && !Number.isNaN(detail.fraction)
            ? Math.max(0, Math.min(1, detail.fraction))
            : 0
        const pct = percentFmt.format(fraction)
        const chapterLabel = detail.tocItem?.label?.trim() || ''

        const segIdx = this.#findSegmentIndexAtFraction(fraction)
        const segInfo = this.#segments.length
            ? `Ch. ${segIdx + 1} / ${this.#segments.length}`
            : ''
        const locText = detail.pageItem?.label
            ? `Page ${detail.pageItem.label}`
            : segInfo

        document.getElementById('reader-chapter-title').textContent = chapterLabel
        document.getElementById('dock-chapter').textContent = chapterLabel || this.bookRecord?.title || ''
        document.getElementById('dock-progress').textContent = [pct, locText].filter(Boolean).join(' · ')

        this.#updateProgressBars(fraction)
        this.#highlightCurrentTOC(detail.tocItem?.href)
        this.#updateRunningMarginals()
        this.#updateBookmarkButton()
        this.#saveProgressDebounced()
    }

    #updateRunningMarginals() {
        const renderer = this.view?.renderer
        if (!renderer || this.view.isFixedLayout || this.isContinuousMode) return

        const title = this.bookRecord?.title || ''
        const chapter = this.#currentLocation?.tocItem?.label?.trim() || ''
        const fraction = this.#currentLocation?.fraction ?? 0
        const pct = percentFmt.format(fraction)
        const loc = this.#currentLocation?.pageItem?.label
            ? `Page ${this.#currentLocation.pageItem.label}`
            : this.#currentLocation?.location?.current != null
                ? `Loc ${this.#currentLocation.location.current}`
                : ''

        if (renderer.heads?.length) {
            if (renderer.heads.length >= 2) {
                renderer.heads[0].textContent = title
                renderer.heads[1].textContent = chapter || title
            } else {
                renderer.heads[0].textContent = chapter || title
            }
        }
        if (renderer.feet?.length) {
            if (renderer.feet.length >= 2) {
                renderer.feet[0].textContent = loc
                renderer.feet[1].textContent = pct
            } else {
                renderer.feet[0].textContent = [loc, pct].filter(Boolean).join(' · ')
            }
        }
    }

    async #persistProgress() {
        if (!this.bookRecord?.id || !this.#currentLocation) return
        const { cfi, fraction, tocItem } = this.#currentLocation
        const patch = {
            lastCfi: cfi || this.bookRecord.lastCfi,
            fraction: typeof fraction === 'number' && !Number.isNaN(fraction) ? fraction : (this.bookRecord.fraction || 0),
            chapterTitle: tocItem?.label?.trim() || this.bookRecord.chapterTitle || '',
            lastOpenedAt: Date.now(),
        }
        Object.assign(this.bookRecord, patch)
        await updateBookProgress(this.bookRecord.id, patch)
    }

    #updateHistoryButtons() {
        const backBtn = document.getElementById('history-back-btn')
        const fwdBtn = document.getElementById('history-fwd-btn')
        if (!this.view) return
        if (backBtn) backBtn.disabled = !this.view.history.canGoBack
        if (fwdBtn) fwdBtn.disabled = !this.view.history.canGoForward
    }

    // ---- Segmented Bottom Chapter Map ----
    #buildChapterSegments() {
        const segEl = document.getElementById('chapter-segments')
        if (!segEl || !this.view) return

        const fractions = this.view.getSectionFractions() || []
        const book = this.view.book
        const linearCount = book.sections.filter(s => s.linear !== 'no').length

        const segs = []
        if (fractions.length >= 2) {
            for (let i = 0; i < fractions.length; i++) {
                const startFrac = fractions[i]
                const endFrac = i + 1 < fractions.length ? fractions[i + 1] : 1
                const span = endFrac - startFrac
                if (span <= 0.0001) continue
                const prog = this.view.getProgressOf(i)
                const label = prog?.tocItem?.label?.trim()
                    || this.#tocFlat[Math.min(segs.length, Math.max(0, this.#tocFlat.length - 1))]?.label
                    || `Section ${segs.length + 1}`
                segs.push({
                    startFrac,
                    endFrac,
                    weight: Math.max(0.015, span),
                    label,
                    bookIndex: i,
                })
            }
        } else {
            const count = Math.max(1, linearCount)
            for (let i = 0; i < count; i++) {
                segs.push({
                    startFrac: i / count,
                    endFrac: (i + 1) / count,
                    weight: 1 / count,
                    label: this.#tocFlat[i]?.label || `Section ${i + 1}`,
                    bookIndex: i,
                })
            }
        }

        // Collapse into max ~40 visual segments if a book has hundreds of tiny files
        this.#segments = segs
        segEl.innerHTML = segs.map((s, idx) => `
            <div class="chapter-seg" data-seg-idx="${idx}" style="flex:${s.weight.toFixed(4)}">
                <div class="chapter-seg-fill"></div>
            </div>
        `).join('')
    }

    #findSegmentIndexAtFraction(frac) {
        if (!this.#segments.length) return 0
        for (let i = this.#segments.length - 1; i >= 0; i--) {
            if (frac >= this.#segments[i].startFrac - 0.0005) return i
        }
        return 0
    }

    #findSegmentAtFraction(frac) {
        return this.#segments[this.#findSegmentIndexAtFraction(frac)] || null
    }

    #updateProgressBars(fraction) {
        const clamped = Math.max(0, Math.min(1, fraction))
        const hairline = document.getElementById('bottom-hairline-fill')
        if (hairline) hairline.style.width = `${(clamped * 100).toFixed(2)}%`

        const mapEl = document.getElementById('chapter-map')
        if (mapEl) mapEl.setAttribute('aria-valuenow', String(Math.round(clamped * 100)))

        const segNodes = document.querySelectorAll('#chapter-segments .chapter-seg')
        segNodes.forEach((node, idx) => {
            const seg = this.#segments[idx]
            if (!seg) return
            const fill = node.querySelector('.chapter-seg-fill')
            const span = Math.max(0.0001, seg.endFrac - seg.startFrac)
            const local = Math.max(0, Math.min(1, (clamped - seg.startFrac) / span))
            if (fill) fill.style.width = `${(local * 100).toFixed(1)}%`
            node.classList.toggle('current', clamped >= seg.startFrac - 0.0005 && clamped <= seg.endFrac + 0.0005)
        })
    }

    async #stepChapter(delta) {
        if (!this.#segments.length) return
        const curFrac = this.#currentLocation?.fraction ?? 0
        const curIdx = this.#findSegmentIndexAtFraction(curFrac)
        const nextIdx = Math.max(0, Math.min(this.#segments.length - 1, curIdx + delta))
        const seg = this.#segments[nextIdx]
        if (seg) await this.#navigateTo(seg.bookIndex)
    }

    // ---- TOC with Full Chapter Names & Enrichment ----
    #renderTOC(toc) {
        const container = document.getElementById('toc-list')
        this.#tocAnchors.clear()
        this.#tocFlat = []
        if (!container) return

        if (!toc.length) {
            container.innerHTML = '<div class="drawer-empty">This book does not include a table of contents.</div>'
            return
        }

        let topLevelCounter = 0
        const enrichQueue = []

        const buildList = (items, depth = 0) => {
            const ol = document.createElement('ol')
            ol.className = depth === 0 ? 'toc-tree' : 'toc-sublist'
            for (const item of items) {
                const rawLabel = (item.label || '').replace(/\s+/g, ' ').trim()
                if (rawLabel) this.#tocFlat.push({ label: rawLabel, href: item.href })
                if (depth === 0) topLevelCounter++

                const li = document.createElement('li')
                const row = document.createElement('div')
                row.className = 'toc-row'
                row.style.setProperty('--depth', String(depth))

                const hasKids = Array.isArray(item.subitems) && item.subitems.length > 0
                let subEl = null

                if (hasKids) {
                    const expBtn = document.createElement('button')
                    expBtn.type = 'button'
                    expBtn.className = 'toc-expand'
                    expBtn.setAttribute('aria-expanded', 'true')
                    expBtn.setAttribute('aria-label', 'Toggle subsections')
                    expBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="m6 9 6 6 6-6"/></svg>'
                    expBtn.addEventListener('click', e => {
                        e.stopPropagation()
                        const expanded = expBtn.getAttribute('aria-expanded') === 'true'
                        expBtn.setAttribute('aria-expanded', String(!expanded))
                        if (subEl) subEl.hidden = expanded
                    })
                    row.append(expBtn)
                }

                const link = document.createElement(item.href ? 'a' : 'span')
                link.className = 'toc-link'

                // Split optional "Title — Subtitle" nicely so chapter name stands out clearly
                const parts = rawLabel.split(/\s+[—–]\s+/)
                const mainTitle = parts[0] || 'Untitled Section'
                const subTitle = parts.slice(1).join(' — ')

                const numHtml = depth === 0
                    ? `<span class="toc-num">${String(topLevelCounter).padStart(2, '0')}</span>`
                    : ''
                link.innerHTML = `
                    ${numHtml}
                    <span class="toc-text">
                        <span class="toc-name">${escapeHtml(mainTitle)}</span>
                        ${subTitle ? `<span class="toc-sub">${escapeHtml(subTitle)}</span>` : ''}
                    </span>
                `

                if (item.href) {
                    link.href = '#'
                    this.#tocAnchors.set(item.href, link)
                    link.addEventListener('click', e => {
                        e.preventDefault()
                        this.#navigateTo(item.href).catch(err => console.error(err))
                        if (window.innerWidth < 900) this.closeDrawer()
                    })

                    // Queue heading enrichment if the TOC entry only gave a bare chapter number
                    if (isBareChapterNumber(rawLabel)) {
                        enrichQueue.push({ href: item.href, link, rawLabel })
                    }
                }
                row.append(link)
                li.append(row)

                if (hasKids) {
                    subEl = buildList(item.subitems, depth + 1)
                    li.append(subEl)
                }
                ol.append(li)
            }
            return ol
        }

        container.replaceChildren(buildList(toc))
        if (enrichQueue.length) this.#enrichBareTOCLabels(enrichQueue)
    }

    async #enrichBareTOCLabels(queue) {
        if (!this.view?.book) return
        const book = this.view.book
        for (const item of queue.slice(0, 40)) {
            try {
                const resolved = book.resolveHref?.(item.href)
                const sec = resolved != null ? book.sections[resolved.index] : null
                if (!sec?.createDocument) continue
                const doc = await sec.createDocument()
                const headings = Array.from(doc.querySelectorAll('h1, h2, h3'))
                    .map(h => h.textContent.replace(/\s+/g, ' ').trim())
                    .filter(t => t && t.length > 1 && t.length < 120 && !isBareChapterNumber(t))
                if (headings[0]) {
                    const nameEl = item.link.querySelector('.toc-name')
                    const textWrap = item.link.querySelector('.toc-text')
                    if (nameEl) nameEl.textContent = headings[0]
                    if (textWrap && !textWrap.querySelector('.toc-sub')) {
                        const sub = document.createElement('span')
                        sub.className = 'toc-sub'
                        sub.textContent = item.rawLabel
                        textWrap.append(sub)
                    }
                }
            } catch {
                // skip gracefully
            }
        }
    }

    #highlightCurrentTOC(href) {
        for (const el of this.#tocAnchors.values()) {
            el.removeAttribute('aria-current')
        }
        if (!href) return
        const active = this.#tocAnchors.get(href)
        if (active) active.setAttribute('aria-current', 'page')
    }

    // ---- Bookmarks & Highlights ----
    #findCurrentBookmark() {
        const curCfi = this.#currentLocation?.cfi
        const curFrac = this.#currentLocation?.fraction
        if (!curCfi) return null
        return this.#annotations.find(a =>
            a.type === 'bookmark'
            && (a.cfi === curCfi || (curFrac != null && a.fraction != null && Math.abs(a.fraction - curFrac) < 0.003))
        ) || null
    }

    #updateBookmarkButton() {
        const btn = document.getElementById('bookmark-btn')
        if (!btn) return
        const has = !!this.#findCurrentBookmark()
        btn.classList.toggle('bookmarked', has)
        btn.setAttribute('aria-pressed', String(has))
        btn.title = has ? 'Remove bookmark (B)' : 'Bookmark this page (B)'
    }

    async #toggleBookmark() {
        if (!this.bookRecord?.id || !this.#currentLocation?.cfi) return
        const existing = this.#findCurrentBookmark()
        if (existing) {
            await this.#removeAnnotation(existing)
            this.#callbacks.onToast('Bookmark removed')
        } else {
            const ann = {
                id: uid(),
                bookId: this.bookRecord.id,
                type: 'bookmark',
                cfi: this.#currentLocation.cfi,
                chapter: this.#currentLocation.tocItem?.label?.trim() || 'Bookmark',
                fraction: this.#currentLocation.fraction ?? 0,
                text: '',
                note: '',
                createdAt: Date.now(),
            }
            await saveAnnotation(ann)
            this.#annotations.push(ann)
            this.#annotations.sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
            this.#updateBookmarkButton()
            this.#renderNotesTab()
            this.#callbacks.onToast('Page bookmarked')
        }
    }

    #getViewportRectForRange(doc, range) {
        const frame = doc.defaultView?.frameElement
        const frameRect = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 }
        const rects = range.getClientRects()
        const r = rects.length ? rects[0] : range.getBoundingClientRect()
        return {
            left: frameRect.left + r.left,
            right: frameRect.left + r.right,
            top: frameRect.top + r.top,
            bottom: frameRect.top + r.bottom,
            width: r.width,
            height: r.height,
        }
    }

    #positionPopover(pop, anchorRect) {
        pop.hidden = false
        const popRect = pop.getBoundingClientRect()
        const pad = 12
        let left = anchorRect.left + anchorRect.width / 2 - popRect.width / 2
        left = Math.max(pad, Math.min(window.innerWidth - popRect.width - pad, left))

        let top = anchorRect.top - popRect.height - 10
        if (top < 56) top = anchorRect.bottom + 10
        top = Math.max(pad, Math.min(window.innerHeight - popRect.height - pad, top))

        pop.style.left = `${Math.round(left)}px`
        pop.style.top = `${Math.round(top)}px`
    }

    #showSelectionPopover(doc, range) {
        const pop = document.getElementById('selection-popover')
        if (!pop) return
        const rect = this.#getViewportRectForRange(doc, range)
        this.#positionPopover(pop, rect)
    }

    #hideSelectionPopover() {
        const pop = document.getElementById('selection-popover')
        if (pop) pop.hidden = true
        this.#activeSelection = null
    }

    async #createHighlightFromSelection(colorId, openNoteAfter) {
        const sel = this.#activeSelection
        if (!sel || !this.bookRecord?.id) return

        const ann = {
            id: uid(),
            bookId: this.bookRecord.id,
            type: 'highlight',
            cfi: sel.cfi,
            text: sel.text,
            note: '',
            color: colorId || 'blue',
            chapter: this.#currentLocation?.tocItem?.label?.trim() || '',
            fraction: this.#currentLocation?.fraction ?? 0,
            createdAt: Date.now(),
        }

        const savedRange = sel.range
        const savedDoc = sel.doc

        await saveAnnotation(ann)
        this.#annotations.push(ann)
        this.#annotations.sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
        this.#rebuildAnnotationMap()

        this.view?.addAnnotation({ value: ann.cfi, ...ann })
        this.scroller?.addAnnotation(ann)
        this.#deselectAll()
        this.#hideSelectionPopover()
        this.#renderNotesTab()

        if (openNoteAfter) {
            this.#openAnnotationPopover(ann, savedRange, savedDoc)
        } else {
            this.#callbacks.onToast('Highlight saved')
        }
    }

    #openAnnotationPopover(ann, range, docOverride = null) {
        const pop = document.getElementById('annotation-popover')
        if (!pop) return
        this.#hideSelectionPopover()
        this.#activeAnnotation = ann

        const quoteEl = document.getElementById('ann-quote')
        const noteEl = document.getElementById('ann-note-input')
        if (quoteEl) quoteEl.textContent = ann.text || ''
        if (noteEl) noteEl.value = ann.note || ''

        const activeColor = resolveHighlightColor(ann.color).id
        pop.querySelectorAll('[data-ann-color]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.annColor === activeColor)
        })

        const doc = docOverride || range?.startContainer?.ownerDocument
        if (doc && range) {
            const rect = this.#getViewportRectForRange(doc, range)
            this.#positionPopover(pop, rect)
        } else {
            pop.hidden = false
            pop.style.left = `${Math.round((window.innerWidth - 300) / 2)}px`
            pop.style.top = '110px'
        }
        noteEl?.focus()
    }

    #hideAnnotationPopover() {
        const pop = document.getElementById('annotation-popover')
        if (pop) pop.hidden = true
        this.#activeAnnotation = null
    }

    async #removeAnnotation(ann) {
        await deleteAnnotation(ann.id)
        this.#annotations = this.#annotations.filter(a => a.id !== ann.id)
        this.#rebuildAnnotationMap()
        if (ann.type === 'highlight' && ann.cfi) {
            this.view?.deleteAnnotation({ value: ann.cfi })
            this.scroller?.deleteAnnotation(ann.cfi)
        }
        this.#updateBookmarkButton()
        this.#renderNotesTab()
    }

    #renderNotesTab() {
        const listEl = document.getElementById('notes-list')
        const countBadge = document.getElementById('notes-count-badge')
        const exportBtn = document.getElementById('export-notes-btn')
        if (!listEl) return

        if (countBadge) {
            countBadge.textContent = this.#annotations.length ? String(this.#annotations.length) : ''
            countBadge.hidden = !this.#annotations.length
        }
        if (exportBtn) exportBtn.hidden = !this.#annotations.length

        if (!this.#annotations.length) {
            listEl.innerHTML = `<div class="drawer-empty">No notes yet.</div>`
            return
        }

        listEl.innerHTML = this.#annotations.map(ann => {
            const pct = ann.fraction != null ? percentFmt.format(ann.fraction) : ''
            const meta = [ann.chapter, pct].filter(Boolean).join(' · ')
            if (ann.type === 'bookmark') {
                return `
                    <div class="note-item note-bookmark" data-note-id="${escapeHtml(ann.id)}">
                        <div class="note-item-head">
                            <span class="note-badge-bm">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3h14v18l-7-4-7 4V3z"/></svg>
                                Bookmark
                            </span>
                            <span class="note-meta">${escapeHtml(pct)}</span>
                            <button type="button" class="note-del-btn" data-del-note="${escapeHtml(ann.id)}" title="Delete">&times;</button>
                        </div>
                        <div class="note-bm-title">${escapeHtml(ann.chapter || 'Saved position')}</div>
                    </div>
                `
            }
            const color = resolveHighlightColor(ann.color)
            return `
                <div class="note-item" data-note-id="${escapeHtml(ann.id)}">
                    <div class="note-item-head">
                        <span class="note-color-swatch" style="background:${color.swatch}"></span>
                        <span class="note-meta">${escapeHtml(meta || 'Highlight')}</span>
                        <button type="button" class="note-del-btn" data-del-note="${escapeHtml(ann.id)}" title="Delete">&times;</button>
                    </div>
                    <blockquote class="note-quote" style="border-left-color:${color.swatch}">${escapeHtml(ann.text)}</blockquote>
                    ${ann.note ? `<p class="note-comment">${escapeHtml(ann.note)}</p>` : ''}
                </div>
            `
        }).join('')

        listEl.querySelectorAll('.note-item').forEach(el => {
            const id = el.dataset.noteId
            const ann = this.#annotations.find(a => a.id === id)
            el.addEventListener('click', e => {
                if (e.target.closest('.note-del-btn')) return
                if (ann?.cfi) {
                    this.#navigateTo(ann.cfi)
                    if (window.innerWidth < 900) this.closeDrawer()
                }
            })
            el.querySelector('.note-del-btn')?.addEventListener('click', async e => {
                e.stopPropagation()
                if (ann) await this.#removeAnnotation(ann)
            })
        })
    }

    #exportNotes() {
        if (!this.bookRecord || !this.#annotations.length) return
        const md = exportNotesMarkdown(this.bookRecord, this.#annotations)
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        const slug = (this.bookRecord.title || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        a.href = url
        a.download = `${slug}-notes.md`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
        this.#callbacks.onToast('Exported notes as Markdown')
    }

    // ---- Search ----
    async #runSearch(query) {
        const statusEl = document.getElementById('search-status')
        const progressEl = document.getElementById('search-progress-bar')
        const resultsEl = document.getElementById('search-results')
        const clearBtn = document.getElementById('book-search-clear')

        if (!query || !this.view) {
            this.#clearSearch()
            return
        }

        const token = ++this.#searchToken
        if (clearBtn) clearBtn.hidden = false
        if (resultsEl) resultsEl.innerHTML = ''
        if (statusEl) statusEl.textContent = 'Searching...'
        if (progressEl) {
            progressEl.hidden = false
            progressEl.style.width = '4%'
        }

        let totalMatches = 0
        try {
            const theme = THEMES[this.settings.theme] || THEMES.light
            for await (const res of this.view.search({
                query,
                draw: Overlayer.outline,
                drawOptions: { color: theme.accent, width: 2 },
            })) {
                if (token !== this.#searchToken) return
                if (res === 'done') break
                if (res.progress != null && progressEl) {
                    progressEl.style.width = `${Math.round(res.progress * 100)}%`
                } else if (res.subitems?.length) {
                    totalMatches += res.subitems.length
                    if (statusEl) {
                        statusEl.textContent = `${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'} found...`
                    }
                    const group = document.createElement('div')
                    group.className = 'search-group'
                    const heading = document.createElement('div')
                    heading.className = 'search-group-title'
                    heading.textContent = res.label || 'Section'
                    group.append(heading)

                    for (const item of res.subitems) {
                        const btn = document.createElement('button')
                        btn.type = 'button'
                        btn.className = 'search-result-item'
                        const { pre = '', match = '', post = '' } = item.excerpt || {}
                        btn.innerHTML = `${escapeHtml(pre)}<mark>${escapeHtml(match)}</mark>${escapeHtml(post)}`
                        btn.addEventListener('click', () => {
                            if (this.isContinuousMode) {
                                this.scroller.goTo(item.cfi, true)
                            } else {
                                this.view?.select(item.cfi)
                            }
                            if (window.innerWidth < 900) this.closeDrawer()
                        })
                        group.append(btn)
                    }
                    resultsEl.append(group)
                }
            }
            if (token !== this.#searchToken) return
            if (progressEl) progressEl.hidden = true
            if (statusEl) {
                statusEl.textContent = totalMatches
                    ? `${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'} in book`
                    : `No matches found for "${query}"`
            }
        } catch (err) {
            console.error('Search error:', err)
            if (statusEl) statusEl.textContent = 'Search is not supported for this book format.'
            if (progressEl) progressEl.hidden = true
        }
    }

    #clearSearch() {
        this.#searchToken++
        this.view?.clearSearch()
        const statusEl = document.getElementById('search-status')
        const progressEl = document.getElementById('search-progress-bar')
        const resultsEl = document.getElementById('search-results')
        const clearBtn = document.getElementById('book-search-clear')
        if (statusEl) statusEl.textContent = ''
        if (progressEl) progressEl.hidden = true
        if (resultsEl) resultsEl.innerHTML = ''
        if (clearBtn) clearBtn.hidden = true
    }

    // ---- Docked Sidebar & Popovers ----
    openDrawer(tab = null) {
        this.#closeAppearancePopover()
        this.#drawerOpen = true
        const readerView = document.getElementById('reader-view')
        const toggleBtn = document.getElementById('drawer-toggle-btn')
        readerView?.classList.add('sidebar-open')
        document.getElementById('drawer')?.classList.add('open')
        document.getElementById('drawer-backdrop')?.classList.add('open')
        if (toggleBtn) {
            toggleBtn.classList.add('active')
            toggleBtn.setAttribute('aria-expanded', 'true')
        }
        if (tab) this.#setDrawerTab(tab)
        if (this.#activeTab === 'toc') {
            setTimeout(() => {
                document.querySelector('#toc-list [aria-current="page"]')
                    ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }, 60)
        }
        if (this.#activeTab === 'search') {
            setTimeout(() => document.getElementById('book-search-input')?.focus(), 120)
        }
        this.#reflowAfterSidebarToggle()
    }

    closeDrawer() {
        this.#drawerOpen = false
        const readerView = document.getElementById('reader-view')
        const toggleBtn = document.getElementById('drawer-toggle-btn')
        readerView?.classList.remove('sidebar-open')
        document.getElementById('drawer')?.classList.remove('open')
        document.getElementById('drawer-backdrop')?.classList.remove('open')
        if (toggleBtn) {
            toggleBtn.classList.remove('active')
            toggleBtn.setAttribute('aria-expanded', 'false')
        }
        this.#reflowAfterSidebarToggle()
    }

    #reflowAfterSidebarToggle() {
        setTimeout(() => {
            if (this.view?.renderer && !this.isContinuousMode && !this.view.isFixedLayout) {
                this.view.renderer.render?.()
            }
        }, 230)
    }

    toggleDrawer() {
        if (this.#drawerOpen) this.closeDrawer()
        else this.openDrawer()
    }

    #setDrawerTab(tab) {
        this.#activeTab = tab
        document.querySelectorAll('.drawer-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === tab)
            b.setAttribute('aria-selected', String(b.dataset.tab === tab))
        })
        document.querySelectorAll('.drawer-panel').forEach(p => {
            p.hidden = p.dataset.panel !== tab
        })
        if (tab === 'search') {
            setTimeout(() => document.getElementById('book-search-input')?.focus(), 60)
        }
    }

    #toggleAppearancePopover() {
        const pop = document.getElementById('appearance-popover')
        if (!pop) return
        const opening = pop.hidden
        if (opening) {
            this.#hideSelectionPopover()
            this.#hideAnnotationPopover()
            pop.hidden = false
        } else {
            pop.hidden = true
        }
    }

    #closeAppearancePopover() {
        const pop = document.getElementById('appearance-popover')
        if (pop) pop.hidden = true
    }

    #setFocusMode(enabled) {
        this.#focusMode = enabled
        document.getElementById('reader-view')?.classList.toggle('focus-mode', enabled)
    }

    #toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen?.().catch(() => {})
        } else {
            document.exitFullscreen?.().catch(() => {})
        }
    }

    #openBookInfoModal() {
        if (!this.bookRecord) return
        const b = this.bookRecord
        const body = document.getElementById('info-modal-body')
        if (!body) return

        const desc = stripHtmlTags(b.description)
        body.innerHTML = `
            <div class="info-grid">
                <div class="info-row"><span>Title</span><strong>${escapeHtml(b.title || 'Untitled')}</strong></div>
                ${b.author ? `<div class="info-row"><span>Author</span><strong>${escapeHtml(b.author)}</strong></div>` : ''}
                ${b.publisher ? `<div class="info-row"><span>Publisher</span><strong>${escapeHtml(b.publisher)}</strong></div>` : ''}
                ${b.language ? `<div class="info-row"><span>Language</span><strong>${escapeHtml(b.language)}</strong></div>` : ''}
                <div class="info-row"><span>Format</span><strong>${escapeHtml(b.format || 'EPUB')}</strong></div>
                <div class="info-row"><span>File Size</span><strong>${escapeHtml(formatBytes(b.fileSize))}</strong></div>
            </div>
            ${desc ? `<div class="info-desc"><h4>Description</h4><p>${escapeHtml(desc)}</p></div>` : ''}
        `
        this.#callbacks.onOpenModal('info-modal')
    }

    #onGlobalClick(e) {
        const ap = document.getElementById('appearance-popover')
        if (ap && !ap.hidden && !ap.contains(e.target) && !e.target.closest('#appearance-btn')) {
            this.#closeAppearancePopover()
        }
        const annPop = document.getElementById('annotation-popover')
        if (annPop && !annPop.hidden && !annPop.contains(e.target)) {
            this.#hideAnnotationPopover()
        }
        const selPop = document.getElementById('selection-popover')
        if (selPop && !selPop.hidden && !selPop.contains(e.target)) {
            this.#hideSelectionPopover()
        }
    }

    #onKeydown(e) {
        if (!this.view) return
        const tag = e.target?.tagName
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable

        if (e.key === 'Escape') {
            if (!document.getElementById('footnote-card')?.hidden) return this.#closeFootnote()
            if (!document.getElementById('annotation-popover')?.hidden) return this.#hideAnnotationPopover()
            if (!document.getElementById('selection-popover')?.hidden) return this.#hideSelectionPopover()
            if (!document.getElementById('appearance-popover')?.hidden) return this.#closeAppearancePopover()
            if (this.#drawerOpen && window.innerWidth < 900) return this.closeDrawer()
            if (this.#focusMode) return this.#setFocusMode(false)
            return
        }

        if (isTyping || e.metaKey || e.ctrlKey || e.altKey) return

        switch (e.key) {
            case 'ArrowLeft':
            case 'PageUp':
            case 'h':
                if (!this.isContinuousMode) {
                    e.preventDefault()
                    this.view.goLeft()
                }
                break
            case 'ArrowRight':
            case 'PageDown':
            case 'l':
                if (!this.isContinuousMode) {
                    e.preventDefault()
                    this.view.goRight()
                }
                break
            case ' ':
                if (!this.isContinuousMode) {
                    e.preventDefault()
                    if (e.shiftKey) this.view.prev()
                    else this.view.next()
                }
                break
            case 'k':
                if (!this.isContinuousMode) {
                    e.preventDefault()
                    this.view.prev()
                }
                break
            case 'j':
                if (!this.isContinuousMode) {
                    e.preventDefault()
                    this.view.next()
                }
                break
            case 't':
                e.preventDefault()
                this.toggleDrawer()
                break
            case '/':
                e.preventDefault()
                this.openDrawer('search')
                break
            case 'a':
                e.preventDefault()
                this.#toggleAppearancePopover()
                break
            case 'b':
                e.preventDefault()
                this.#toggleBookmark()
                break
            case 'f':
                e.preventDefault()
                this.#toggleFullscreen()
                break
            case '?':
                e.preventDefault()
                this.#callbacks.onOpenModal('shortcuts-modal')
                break
        }
    }
}
