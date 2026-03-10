import { createContext, useContext } from 'react'
import type { IChatWebSocket } from '../services/websocket'

export const WebSocketContext = createContext<IChatWebSocket | null>(null)

export function useWebSocket(): IChatWebSocket | null {
  return useContext(WebSocketContext)
}
