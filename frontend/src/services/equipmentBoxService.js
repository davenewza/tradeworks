class EquipmentBoxService {
  constructor() {
    this.baseUrl = 'http://localhost:8000/api/json'
  }

  async makeRequest(endpoint, data = null) {
    const url = `${this.baseUrl}${endpoint}`
    const options = {
      method: data ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    }

    if (data) {
      options.body = JSON.stringify(data)
    }

    const response = await fetch(url, options)
    
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.message || `HTTP error! status: ${response.status}`)
    }

    return response.json()
  }

  // Calculate equipment boxes for a quote
  async calculateEquipmentBoxes(quoteId, boxType) {
    return this.makeRequest('/calculateEquipmentBoxes', { id: quoteId, boxType: boxType })
  }

  // Remove equipment boxes for a quote
  async removeEquipmentBoxes(quoteId) {
    return this.makeRequest('/removeEquipmentBoxes', { id: quoteId })
  }

  // List equipment boxes for a quote
  async listQuoteEquipmentBoxes(quoteId) {
    return this.makeRequest('/listQuoteEquipmentBoxes', {
      where: {
        quote: {
          id: {
            equals: quoteId
          }
        }
      }
    })
  }

  // Get equipment box details
  async getEquipmentBox(equipmentBoxId) {
    return this.makeRequest('/getEquipmentBox', { id: equipmentBoxId })
  }

  // List all equipment boxes
  async listEquipmentBoxes() {
    return this.makeRequest('/listEquipmentBoxes')
  }
}

export const equipmentBoxService = new EquipmentBoxService()
