import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class PriceListService {
  async makeRequest(endpoint, data = null) {
    const headers = {
      'Content-Type': 'application/json',
    }
    
    // Add authentication header if available
    const token = authService.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    
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

  // Get all price lists
  async getPriceLists() {
    const response = await this.makeRequest('/listPriceLists')
    return response.results || []
  }

  // Get a specific price list
  async getPriceList(priceListId) {
    return await this.makeRequest('/getPriceList', { id: priceListId })
  }

  // Create a new price list
  async createPriceList(name) {
    return await this.makeRequest('/createPriceList', { name })
  }

  // Update a price list
  async updatePriceList(priceListId, name) {
    return await this.makeRequest('/updatePriceList', {
      where: { id: priceListId },
      values: { name }
    })
  }

  // Delete a price list
  async deletePriceList(priceListId) {
    return await this.makeRequest('/deletePriceList', { id: priceListId })
  }

  // Get customer price lists for a specific customer
  async getCustomerPriceLists(customerId) {
    const response = await this.makeRequest('/listCustomerPriceLists', {
      where: {
        customer: {
          id: {
            equals: customerId
          }
        }
      }
    })
    return response.results || []
  }

  // Get a specific customer price list by ID
  async getCustomerPriceList(customerPriceListId) {
    const response = await this.makeRequest('/listCustomerPriceLists', {
      where: {
        id: {
          equals: customerPriceListId
        }
      }
    })
    return response.results?.[0] || null
  }

  // Create a customer price list association
  async createCustomerPriceList(customerId, priceListId) {
    return await this.makeRequest('/createCustomerPriceList', {
      customer: { id: customerId },
      priceList: { id: priceListId }
    })
  }

  // Delete a customer price list association
  async deleteCustomerPriceList(customerPriceListId) {
    return await this.makeRequest('/deleteCustomerPriceList', { id: customerPriceListId })
  }
}

export const priceListService = new PriceListService()
