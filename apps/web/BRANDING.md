# PendingTree logo

- logo.svg              icon + wordmark (for dark backgrounds)
- favicon.svg           icon only, solid dots, dark rounded square
- PendingTreeLogo.vue   Vue 3 component (props: size, showText, theme)

## Use in Vue / Vite
1. Put favicon.svg in /public, then in index.html:
   <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
2. Sidebar:
   import PendingTreeLogo from '@/components/PendingTreeLogo.vue'
   <PendingTreeLogo :size="32" />
   Icon only: <PendingTreeLogo :size="24" :show-text="false" />
   Light background: <PendingTreeLogo theme="light" />
