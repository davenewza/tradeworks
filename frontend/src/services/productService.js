import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class ProductService {
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

  // Get all products
  async getProducts() {
    const response = await this.makeRequest('/listProducts', {
      limit: 500
    })
    return response.results || []
  }

  // Get a specific product
  async getProduct(productId) {
    return await this.makeRequest('/getProduct', { id: productId })
  }


  // Get product prices by price list
  async getProductPricesByPriceList(priceListId) {
    const response = await this.makeRequest('/listProductPrices', {
      where: {
        priceList: {
          id: {
            equals: priceListId
          }
        }
      },
      limit: 500
    })
    return response.results || []
  }

  // List all brands
  async listBrands() {
    const response = await this.makeRequest('/listBrands', {})
    return response.results || []
  }
}

export const productService = new ProductService()
