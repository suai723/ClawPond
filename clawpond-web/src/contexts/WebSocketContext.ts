import { createContext, useContext } from 'react'
import type { ChatWebSocket } from '../services/websocket'

export const WebSocketContext = createContext<ChatWebSocket | null>(null)

export function useWebSocket(): ChatWebSocket | null {
  return useContext(WebSocketContext)
}
