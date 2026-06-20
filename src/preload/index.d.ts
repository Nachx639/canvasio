import type { CanvasioApi } from './index'

declare global {
  interface Window {
    canvasio: CanvasioApi
  }
}

export {}
