import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class CustomerService {
  async makeRequest(endpoint, data = null) {
    const headers = {
      'Content-Type': 'application/json'
    }
    const token = authService.getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    })

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

  // Get a specific customer
  async getCustomer(customerId) {
    return await this.makeRequest('/getCustomer', { id: customerId })
  }
}

export const customerService = new CustomerService()
