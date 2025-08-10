import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class UserService {
  constructor() {
    this.baseUrl = API_BASE
  }

  async makeRequest(endpoint, data = null) {
    const url = `${this.baseUrl}${endpoint}`
    const headers = { 'Content-Type': 'application/json' }
    const token = authService.getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    })

    if (!response.ok) {
      let message = `HTTP error ${response.status}`
      try {
        const err = await response.json()
        if (err?.message) message = err.message
      } catch {}
      if (typeof message === 'string' && message.toLowerCase().includes('token has expired')) {
        authService.logout()
        window.location.reload()
      }
      throw new Error(message)
    }

    return response.json()
  }

  async getUser(id) {
    return this.makeRequest('/getUser', { id })
  }
}

export const userService = new UserService()


