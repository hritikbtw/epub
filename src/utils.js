const listFormat = new Intl.ListFormat('en', { style: 'short', type: 'conjunction' })

export const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    const keys = Object.keys(x)
    return x[keys[0]] ?? ''
}

export const formatOneContributor = contributor => {
    if (!contributor) return ''
    return typeof contributor === 'string'
        ? contributor
        : formatLanguageMap(contributor.name)
}

export const formatContributor = contributor => {
    if (!contributor) return ''
    if (Array.isArray(contributor)) {
        const names = contributor.map(formatOneContributor).filter(Boolean)
        return names.length ? listFormat.format(names) : ''
    }
    return formatOneContributor(contributor)
}

export const formatBytes = bytes => {
    if (!bytes || bytes < 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let val = bytes
    while (val >= 1024 && i < units.length - 1) {
        val /= 1024
        i++
    }
    return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`
}

export const formatRelativeTime = ts => {
    if (!ts) return ''
    const diff = Date.now() - ts
    const sec = Math.floor(diff / 1000)
    if (sec < 60) return 'Just now'
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ago`
    const days = Math.floor(hr / 24)
    if (days < 7) return `${days}d ago`
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const getFormatBadge = fileName => {
    const ext = (fileName || '').split('.').pop()?.toLowerCase()
    const map = {
        epub: 'EPUB',
        mobi: 'MOBI',
        azw: 'AZW',
        azw3: 'AZW3',
        kf8: 'KF8',
        fb2: 'FB2',
        fbz: 'FB2',
        cbz: 'CBZ',
        pdf: 'PDF',
    }
    return map[ext] || 'BOOK'
}

export const escapeHtml = str => String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export const debounce = (fn, wait = 200) => {
    let timer
    return (...args) => {
        clearTimeout(timer)
        timer = setTimeout(() => fn(...args), wait)
    }
}

export const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)

// Fast deterministic fingerprint from file size + first 16KB + name
export const fingerprintFile = async file => {
    const head = new Uint8Array(await file.slice(0, 16384).arrayBuffer())
    let h1 = 0xdeadbeef ^ file.size
    let h2 = 0x41c6ce57 ^ file.size
    for (let i = 0; i < head.length; i++) {
        const ch = head[i]
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
    return `bk-${hash}-${file.size.toString(36)}`
}

// Bespoke literary cloth palettes for books without cover art
const COVER_PALETTES = [
    { bg: '#263832', fg: '#F3ECE0', accent: '#D8B273' }, // Forest cloth
    { bg: '#3E272A', fg: '#F5EDE6', accent: '#E0A890' }, // Oxblood
    { bg: '#243242', fg: '#EFF2F5', accent: '#9CC0DF' }, // Prussian navy
    { bg: '#4B3A28', fg: '#F7F1E7', accent: '#DFBE8C' }, // Umber linen
    { bg: '#2F363B', fg: '#F1F2F0', accent: '#C6B99B' }, // Slate charcoal
    { bg: '#4A3142', fg: '#F6EEF2', accent: '#DFB0CB' }, // Plum cloth
    { bg: '#2E3E3B', fg: '#EEF4F1', accent: '#9FC8B9' }, // Deep sage
    { bg: '#5B3A29', fg: '#F8F0E8', accent: '#E4BA94' }, // Terracotta cloth
]

export const getCoverPalette = title => {
    let hash = 0
    const s = title || 'Book'
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0
    return COVER_PALETTES[Math.abs(hash) % COVER_PALETTES.length]
}

export const stripHtmlTags = html => {
    if (!html) return ''
    const div = document.createElement('div')
    div.innerHTML = html
    return (div.textContent || '').replace(/\s+/g, ' ').trim()
}

export const exportNotesMarkdown = (book, annotations) => {
    const lines = [
        `# ${book.title || 'Untitled Book'}`,
        book.author ? `*by ${book.author}*` : '',
        '',
        `Exported from Folio on ${new Date().toLocaleDateString()}`,
        '',
        '---',
        '',
    ]
    const highlights = annotations.filter(a => a.type === 'highlight')
    const bookmarks = annotations.filter(a => a.type === 'bookmark')

    if (highlights.length) {
        lines.push('## Highlights', '')
        for (const h of highlights) {
            const meta = [h.chapter, h.fraction != null ? `${Math.round(h.fraction * 100)}%` : ''].filter(Boolean).join(' · ')
            if (meta) lines.push(`### ${meta}`)
            lines.push(`> ${h.text.replace(/\n+/g, '\n> ')}`, '')
            if (h.note) lines.push(h.note, '')
        }
    }
    if (bookmarks.length) {
        lines.push('## Bookmarks', '')
        for (const b of bookmarks) {
            const pct = b.fraction != null ? ` (${Math.round(b.fraction * 100)}%)` : ''
            lines.push(`- **${b.chapter || 'Bookmark'}**${pct}${b.text ? ` — ${b.text}` : ''}`)
        }
        lines.push('')
    }
    return lines.filter(l => l !== undefined).join('\n')
}
