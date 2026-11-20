export const THEMES = {
    light: {
        id: 'light',
        name: 'Light',
        scheme: 'light',
        bg: '#FFFFFF',
        surface: '#F4F5F7',
        ink: '#141518',
        inkMuted: '#5C616B',
        accent: '#235390',
        selection: 'rgba(35, 83, 144, 0.2)',
        swatchBg: '#FFFFFF',
        swatchRing: '#D2D6DD',
    },
    stone: {
        id: 'stone',
        name: 'Stone',
        scheme: 'light',
        bg: '#F2F3F4',
        surface: '#E8EAED',
        ink: '#1B1D21',
        inkMuted: '#5F656F',
        accent: '#374C66',
        selection: 'rgba(55, 76, 102, 0.2)',
        swatchBg: '#F2F3F4',
        swatchRing: '#C8CDD4',
    },
    sage: {
        id: 'sage',
        name: 'Sage',
        scheme: 'light',
        bg: '#ECF1EE',
        surface: '#E1E9E4',
        ink: '#17231E',
        inkMuted: '#4E635A',
        accent: '#275E4B',
        selection: 'rgba(39, 94, 75, 0.2)',
        swatchBg: '#ECF1EE',
        swatchRing: '#C2D0C8',
    },
    nord: {
        id: 'nord',
        name: 'Nord',
        scheme: 'dark',
        bg: '#242933',
        surface: '#2C323F',
        ink: '#D8DEE9',
        inkMuted: '#919EB2',
        accent: '#88C0D0',
        selection: 'rgba(136, 192, 208, 0.28)',
        swatchBg: '#242933',
        swatchRing: '#434C5E',
    },
    charcoal: {
        id: 'charcoal',
        name: 'Charcoal',
        scheme: 'dark',
        bg: '#18181B',
        surface: '#222226',
        ink: '#E4E4E7',
        inkMuted: '#94949E',
        accent: '#7FA9E3',
        selection: 'rgba(127, 169, 227, 0.28)',
        swatchBg: '#18181B',
        swatchRing: '#383840',
    },
    obsidian: {
        id: 'obsidian',
        name: 'Obsidian',
        scheme: 'dark',
        bg: '#0A0B0D',
        surface: '#13151A',
        ink: '#CED2DA',
        inkMuted: '#7E8594',
        accent: '#749CD6',
        selection: 'rgba(116, 156, 214, 0.28)',
        swatchBg: '#0A0B0D',
        swatchRing: '#2A2F3A',
    },
    sepia: {
        id: 'sepia',
        name: 'Sepia',
        scheme: 'light',
        bg: '#EFE6D5',
        surface: '#E5D9C3',
        ink: '#352A1E',
        inkMuted: '#725F4A',
        accent: '#7C4D25',
        selection: 'rgba(124, 77, 37, 0.22)',
        swatchBg: '#EFE6D5',
        swatchRing: '#CEBEA3',
    },
}

export const HIGHLIGHT_COLORS = {
    blue: { id: 'blue', name: 'Blue', hex: '#4B8CE0', swatch: '#3E81D6' },
    green: { id: 'green', name: 'Green', hex: '#49A372', swatch: '#3D9665' },
    gold: { id: 'gold', name: 'Gold', hex: '#E3A82B', swatch: '#D99B1F' },
    rose: { id: 'rose', name: 'Rose', hex: '#D9607A', swatch: '#CC526D' },
}

export const FONTS = {
    publisher: {
        id: 'publisher',
        name: 'Publisher',
        sample: 'Aa',
        css: null,
        previewStack: 'Georgia, serif',
    },
    newsreader: {
        id: 'newsreader',
        name: 'Newsreader',
        sample: 'Aa',
        css: '"Newsreader", "Iowan Old Style", "Palatino Linotype", Georgia, serif',
        previewStack: '"Newsreader", Georgia, serif',
    },
    literata: {
        id: 'literata',
        name: 'Literata',
        sample: 'Aa',
        css: '"Literata", "Charter", "Bitstream Charter", Georgia, serif',
        previewStack: '"Literata", Georgia, serif',
    },
    garamond: {
        id: 'garamond',
        name: 'Garamond',
        sample: 'Aa',
        css: '"EB Garamond", Garamond, "Times New Roman", serif',
        previewStack: '"EB Garamond", Garamond, serif',
    },
    sans: {
        id: 'sans',
        name: 'Inter',
        sample: 'Aa',
        css: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        previewStack: '"Inter", system-ui, sans-serif',
    },
    mono: {
        id: 'mono',
        name: 'Mono',
        sample: 'Aa',
        css: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        previewStack: '"JetBrains Mono", monospace',
    },
}

export const WIDTH_PRESETS = {
    narrow: { id: 'narrow', label: 'Narrow', maxInline: '600px' },
    medium: { id: 'medium', label: 'Medium', maxInline: '720px' },
    wide: { id: 'wide', label: 'Wide', maxInline: '880px' },
}

export const DEFAULT_SETTINGS = {
    theme: 'light',
    layout: 'spread', // 'spread' | 'single' | 'scrolled'
    fontFamily: 'newsreader',
    fontSize: 19,
    lineHeight: 1.65,
    pageWidth: 'medium',
    justify: true,
    hyphenate: true,
    overrideStyles: true,
}

const STORAGE_KEY = 'folio-reader-settings-v2'

export const loadSettings = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return { ...DEFAULT_SETTINGS }
        const parsed = JSON.parse(raw)
        const merged = { ...DEFAULT_SETTINGS, ...parsed }
        if (!THEMES[merged.theme]) merged.theme = DEFAULT_SETTINGS.theme
        return merged
    } catch {
        return { ...DEFAULT_SETTINGS }
    }
}

export const saveSettings = settings => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
        // ignore storage quota errors
    }
}

export const applyAppTheme = themeId => {
    const theme = THEMES[themeId] || THEMES.light
    document.documentElement.dataset.theme = theme.id
    const metaTheme = document.querySelector('meta[name="theme-color"]')
    if (metaTheme) metaTheme.setAttribute('content', theme.bg)
    return theme
}

const GOOGLE_FONTS_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..600;1,400..600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Literata:ital,opsz,wght@0,7..72,400..600;1,7..72,400..600&family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..600&display=swap');`

export const buildBookCSS = settings => {
    const theme = THEMES[settings.theme] || THEMES.light
    const font = FONTS[settings.fontFamily] || FONTS.publisher
    const isDark = theme.scheme === 'dark'
    const imp = settings.overrideStyles ? ' !important' : ''
    const fontRule = font.css ? `font-family: ${font.css}${imp};` : ''

    return `
        ${font.css ? GOOGLE_FONTS_IMPORT : ''}
        @namespace epub "http://www.idpf.org/2007/ops";

        html {
            color-scheme: ${theme.scheme};
            background: ${theme.bg} !important;
            color: ${theme.ink} !important;
            font-size: ${settings.fontSize}px${imp};
            -webkit-font-smoothing: antialiased;
            text-rendering: optimizeLegibility;
        }

        body {
            background: ${theme.bg} !important;
            color: ${theme.ink} !important;
            ${fontRule}
            line-height: ${settings.lineHeight}${imp};
            hanging-punctuation: allow-end last;
        }

        ${isDark ? `
        body, p, li, div, span, section, article, main, blockquote, dd, dt, td, th, figcaption,
        h1, h2, h3, h4, h5, h6 {
            color: ${theme.ink} !important;
            background-color: transparent !important;
            border-color: rgba(255, 255, 255, 0.14) !important;
        }
        img, svg {
            filter: brightness(0.92);
        }
        ` : `
        body, p, li, blockquote, dd, dt, figcaption, h1, h2, h3, h4, h5, h6 {
            color: ${theme.ink}${imp};
        }
        `}

        ${font.css ? `
        p, li, blockquote, dd, dt, div, span, h1, h2, h3, h4, h5, h6 {
            font-family: ${font.css}${imp};
        }
        code, pre, kbd, samp {
            font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace !important;
        }
        ` : ''}

        p, li, blockquote, dd {
            line-height: ${settings.lineHeight}${imp};
            text-align: ${settings.justify ? 'justify' : 'start'};
            -webkit-hyphens: ${settings.hyphenate ? 'auto' : 'manual'};
            hyphens: ${settings.hyphenate ? 'auto' : 'manual'};
            -webkit-hyphenate-limit-before: 3;
            -webkit-hyphenate-limit-after: 2;
            -webkit-hyphenate-limit-lines: 2;
            orphans: 2;
            widows: 2;
        }

        [align="left"] { text-align: left !important; }
        [align="right"] { text-align: right !important; }
        [align="center"] { text-align: center !important; }
        [align="justify"] { text-align: justify !important; }

        a, a:link, a:visited {
            color: ${theme.accent} !important;
            text-decoration-color: ${theme.accent};
            text-underline-offset: 0.18em;
        }

        blockquote {
            border-left-color: ${theme.accent} !important;
            opacity: 0.92;
        }

        img, svg, video {
            max-width: 100%;
            height: auto;
        }

        pre {
            white-space: pre-wrap !important;
            font-size: 0.88em;
        }

        ::selection {
            background: ${theme.selection};
        }

        aside[epub|type~="endnote"],
        aside[epub|type~="footnote"],
        aside[epub|type~="note"],
        aside[epub|type~="rearnote"] {
            display: none;
        }
    `
}
