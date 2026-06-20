/// <reference types="vite/client" />

// Static asset imports (Vite resolves these to a URL string at build time).
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
