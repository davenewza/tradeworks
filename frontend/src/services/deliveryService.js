import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class DeliveryService {
  constructor() {
    this.baseUrl = API_BASE
  }

  async makeRequest(endpoint, data = null) {
    const url = `${this.baseUrl}${endpoint}`
    const headers = {
      'Content-Type': 'application/json',
    }
    
    // Add authentication header if available
    const token = authService.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    
    const options = {
      method: data ? 'POST' : 'GET',
      headers,
    }

    if (data) {
      options.body = JSON.stringify(data)
    }

    const response = await fetch(url, options)
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const message = errorData.message || `HTTP error! status: ${response.status}`
      if (typeof message === 'string' && message.toLowerCase().includes('token has expired')) {
        authService.logout()
        window.location.reload()
      }
      throw new Error(message)
    }

    return response.json()
  }

  // Calculate delivery rates for a quote
  async calculateDelivery(quoteId) {
    return this.makeRequest('/calculateDelivery', { id: quoteId })
  }
}

export const deliveryService = new DeliveryService()
