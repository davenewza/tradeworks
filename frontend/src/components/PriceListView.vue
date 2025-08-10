<template>
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
    <!-- Header -->
      <div class="flex justify-between items-start mb-6">
      <div>
        <h3 class="text-xl font-semibold text-gray-900 mb-1">{{ priceList.name }}</h3>
        <p class="text-sm text-gray-600">
          Created: {{ formatDate(priceList.createdAt) }}
        </p>
        <p class="text-sm text-gray-600">
          {{ productPrices.length }} products
        </p>
      </div>
        <div class="flex items-center gap-2">
          <button 
            @click="openChangeLog"
            class="btn btn-secondary text-sm"
            title="View Change Log"
          >
            Change Log
          </button>
          <button 
            @click="$emit('close')"
            class="btn btn-secondary text-sm"
            title="Close"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="flex justify-center items-center py-8">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="text-center py-8">
      <div class="text-red-500 mb-4">
        <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
      </div>
      <h4 class="text-lg font-medium text-gray-900 mb-2">Error loading products</h4>
      <p class="text-gray-600">{{ error }}</p>
    </div>

    <!-- Empty State -->
    <div v-else-if="productPrices.length === 0" class="text-center py-8">
      <div class="text-gray-500 mb-4">
        <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"></path>
        </svg>
      </div>
      <h4 class="text-lg font-medium text-gray-900 mb-2">No products found</h4>
      <p class="text-gray-600">This price list doesn't contain any products.</p>
    </div>

    <!-- Products List -->
    <div v-else>
      <!-- Brand Filters -->
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <button
          class="px-3 py-1.5 rounded-full text-xs font-medium border"
          :class="selectedBrandId === 'ALL' ? 'bg-gray-800 text-white border-gray-800' : 'text-gray-700 border-gray-300 hover:border-gray-400'"
          @click="selectedBrandId = 'ALL'"
        >
          All
        </button>
        <button
          v-for="b in brands"
          :key="b.id"
          class="px-3 py-1.5 rounded-full text-xs font-medium border"
          :class="selectedBrandId === b.id ? 'bg-brand-navy text-white border-brand-navy' : 'text-gray-700 border-gray-300 hover:border-gray-400'"
          @click="selectedBrandId = b.id"
        >
          {{ b.name }}
        </button>
      </div>
      <!-- Header Row -->
      <div class="flex justify-between items-center mb-4 px-4 py-2 bg-gray-50 rounded-lg">
        <div class="min-h-[2rem] flex flex-col justify-center">
          <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Product</h4>
        </div>
        <div class="flex items-center space-x-8">
          <div class="w-24 text-right">
            <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Price</h4>
          </div>
          <div class="w-24 text-right whitespace-nowrap">
            <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Price (incl. VAT)</h4>
          </div>
        </div>
      </div>

      <!-- Products -->
      <div class="space-y-2">
        <div 
          v-for="productPrice in filteredProductPrices" 
          :key="productPrice.id" 
          class="border border-gray-200 rounded-lg p-2 hover:bg-gray-50 transition-colors"
        >
          <div class="flex justify-between items-center">
            <div class="flex items-center space-x-4">
              <div class="relative w-12 h-12">
                <img 
                  v-if="productDetails[productPrice.productId]?.image?.url" 
                  :src="productDetails[productPrice.productId].image.url" 
                  :alt="productDetails[productPrice.productId]?.name"
                  class="w-12 h-12 object-cover rounded-lg cursor-pointer"
                  @mouseenter="showImagePreview(productPrice.productId, $event)"
                  @mousemove="updateImagePreviewPosition($event)"
                  @mouseleave="hideImagePreview"
                />
                <div 
                  v-else 
                  class="w-12 h-12 bg-gray-200 rounded-lg flex items-center justify-center"
                >
                  <svg class="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                  </svg>
                </div>
              </div>
              <div class="min-h-[2rem] flex flex-col justify-center">
                <h4 class="font-medium text-gray-900">{{ productDetails[productPrice.productId]?.name || productPrice.productName }}</h4>
                <p class="text-sm text-gray-600">SKU: {{ productDetails[productPrice.productId]?.sku || productPrice.productSku }}</p>
              </div>
            </div>
            <div class="flex items-center space-x-8">
              <div class="w-24 text-right">
                <p class="text-sm font-medium text-gray-900">ZAR {{ formatCurrency(productPrice.price) }}</p>
              </div>
              <div class="w-24 text-right whitespace-nowrap">
                <p class="text-sm font-bold text-gray-900">ZAR {{ formatCurrency(productPrice.priceInclVat) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Image Preview Overlay -->
    <div 
      v-if="imagePreview.show"
      :style="{
        position: 'fixed',
        top: imagePreview.y + 'px',
        left: imagePreview.x + 'px',
        zIndex: 1000,
        pointerEvents: 'none'
      }"
      class="bg-white border border-gray-300 rounded-lg shadow-lg p-2"
    >
      <img 
        :src="imagePreview.src" 
        :alt="imagePreview.alt"
        class="w-60 h-60 object-contain rounded bg-white"
      />
    </div>

  <!-- Change Log Modal -->
  <div v-if="showChangeLog" class="fixed inset-0 z-50 flex items-center justify-center">
    <div class="absolute inset-0 bg-black bg-opacity-50" @click="closeChangeLog"></div>
    <div class="relative bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden">
      <div class="flex items-center justify-between p-4 border-b border-gray-200">
        <h3 class="text-lg font-semibold text-gray-900">Price List Change Log</h3>
        <button @click="closeChangeLog" class="text-gray-400 hover:text-gray-600">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="p-4 overflow-y-auto max-h-[calc(90vh-120px)]">
        <div v-if="!changeLog.length" class="text-sm text-gray-600">No changes recorded.</div>
        <ul v-else class="space-y-3">
          <li v-for="entry in changeLog" :key="entry.id" class="border rounded p-3">
            <div class="flex justify-between text-sm">
              <span v-if="entry.changeType || entry.type" class="font-medium text-gray-900">{{ entry.changeType || entry.type }}</span>
              <span class="text-gray-600">{{ formatDateTime(entry.createdAt) }} · {{ entry.createdByName || '—' }}</span>
            </div>
            <div v-if="entry.description" class="text-sm text-gray-700 mt-1">{{ entry.description }}</div>
            <div v-else-if="entry.details" class="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{{ JSON.stringify(entry.details, null, 2) }}</div>
          </li>
        </ul>
      </div>
      <div class="p-4 border-t border-gray-200 flex justify-end">
        <button @click="closeChangeLog" class="btn btn-secondary">Close</button>
      </div>
    </div>
    </div>

    <!-- Change Log Modal -->
    <div v-if="showChangeLog" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black bg-opacity-50" @click="closeChangeLog"></div>
      <div class="relative bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden">
        <div class="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 class="text-lg font-semibold text-gray-900">Price List Change Log</h3>
          <button @click="closeChangeLog" class="text-gray-400 hover:text-gray-600">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="p-4 overflow-y-auto max-h-[calc(90vh-120px)]">
          <div v-if="!changeLog.length" class="text-sm text-gray-600">No changes recorded.</div>
          <ul v-else class="space-y-3">
            <li v-for="entry in changeLog" :key="entry.id" class="border rounded p-3">
              <div class="flex justify-between text-sm">
                <span class="font-medium text-gray-900">{{ entry.changeType || entry.type || 'Change' }}</span>
                <span class="text-gray-600">{{ formatDate(entry.createdAt) }}</span>
              </div>
              <div v-if="entry.description" class="text-sm text-gray-700 mt-1">{{ entry.description }}</div>
              <div v-else-if="entry.details" class="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{{ JSON.stringify(entry.details, null, 2) }}</div>
            </li>
          </ul>
        </div>
        <div class="p-4 border-t border-gray-200 flex justify-end">
          <button @click="closeChangeLog" class="btn btn-secondary">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { productService } from '../services/productService.js'

export default {
  name: 'PriceListView',
  props: {
    priceList: {
      type: Object,
      required: true
    }
  },
  data() {
    return {
      productPrices: [],
      productDetails: {}, // Store product details by productId
      loading: true,
      error: null,
      brands: [],
      selectedBrandId: 'ALL',
      showChangeLog: false,
      changeLog: [],
      imagePreview: {
        show: false,
        src: '',
        alt: '',
        x: 0,
        y: 0
      }
    }
  },
  async mounted() {
    await Promise.all([
      this.loadProductPrices(),
      this.loadBrands()
    ])
    await this.loadProductDetails()
  },
  methods: {
    async openChangeLog() {
      try {
        const priceListId = this.priceList.priceListId || this.priceList.id
        const { priceListService } = await import('../services/priceListService.js')
        const entries = await priceListService.listPriceListChangeLog(priceListId)
        // If names missing but createdBy id present, try to hydrate
        const missing = entries.filter(e => !e.createdByName && (e.createdById || e.createdBy))
        if (missing.length) {
          try {
            const { userService } = await import('../services/userService.js')
            await Promise.all(missing.map(async e => {
              try {
                const id = e.createdById || e.createdBy
                const u = await userService.getUser(id)
                e.createdByName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id
              } catch {}
            }))
          } catch {}
        }
        this.changeLog = entries
        this.showChangeLog = true
      } catch (e) {
        alert('Failed to load change log: ' + (e.message || 'Unknown error'))
      }
    },
    closeChangeLog() {
      this.showChangeLog = false
    },
    async loadBrands() {
      try {
        const brands = await productService.listBrands()
        this.brands = brands
      } catch (e) {
        console.error('Failed to load brands', e)
        this.brands = []
      }
    },
    async loadProductPrices() {
      try {
        this.loading = true
        this.error = null
        
        // Get the actual price list ID from the customer price list relationship
        const priceListId = this.priceList.priceListId || this.priceList.id
        
        this.productPrices = await productService.getProductPricesByPriceList(priceListId)
        console.log('Product prices loaded:', this.productPrices)
      } catch (err) {
        console.error('Failed to load product prices:', err)
        this.error = err.message || 'Failed to load product prices'
      } finally {
        this.loading = false
      }
    },
    
    async loadProductDetails() {
      try {
        for (const productPrice of this.productPrices) {
          if (!this.productDetails[productPrice.productId]) {
            try {
              this.productDetails[productPrice.productId] = await productService.getProduct(productPrice.productId)
            } catch (err) {
              console.error(`Failed to load product ${productPrice.productId}:`, err)
            }
          }
        }
      } catch (err) {
        console.error('Failed to load product details:', err)
      }
    },
    
    formatDate(dateString) {
      if (!dateString) return '—'
      const d = new Date(dateString)
      const day = String(d.getDate()).padStart(2, '0')
      const month = d.toLocaleString('en-GB', { month: 'short' })
      const year = d.getFullYear()
      return `${day} ${month} ${year}`
    },
    formatDateTime(dateString) {
      if (!dateString) return '—'
      const d = new Date(dateString)
      const day = String(d.getDate()).padStart(2, '0')
      const month = d.toLocaleString('en-GB', { month: 'short' })
      const year = d.getFullYear()
      const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      return `${day} ${month} ${year} ${time}`
    },
    
    formatCurrency(amount) {
      if (!amount) return '0.00'
      return parseFloat(amount).toLocaleString('en-ZA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    },
    
    showImagePreview(productId, event) {
      const product = this.productDetails[productId]
      if (product?.image?.url) {
        // Calculate initial position with offset to avoid going off-screen
        const offsetX = 10
        const offsetY = 10
        const previewWidth = 250 // increased ~25% for larger preview
        const previewHeight = 250 // increased ~25% for larger preview
        
        let x = event.clientX + offsetX
        let y = event.clientY + offsetY
        
        // Adjust if preview would go off the right edge
        if (x + previewWidth > window.innerWidth) {
          x = event.clientX - previewWidth - offsetX
        }
        
        // Adjust if preview would go off the bottom edge
        if (y + previewHeight > window.innerHeight) {
          y = event.clientY - previewHeight - offsetY
        }
        
        this.imagePreview = {
          show: true,
          src: product.image.url,
          alt: product.name || 'Product',
          x: x,
          y: y
        }
      }
    },
    
    updateImagePreviewPosition(event) {
      if (this.imagePreview.show) {
        // Calculate position with offset to avoid going off-screen
        const offsetX = 10
        const offsetY = 10
        const previewWidth = 250 // match increased preview size
        const previewHeight = 250 // match increased preview size
        
        let x = event.clientX + offsetX
        let y = event.clientY + offsetY
        
        // Adjust if preview would go off the right edge
        if (x + previewWidth > window.innerWidth) {
          x = event.clientX - previewWidth - offsetX
        }
        
        // Adjust if preview would go off the bottom edge
        if (y + previewHeight > window.innerHeight) {
          y = event.clientY - previewHeight - offsetY
        }
        
        this.imagePreview.x = x
        this.imagePreview.y = y
      }
    },
    
    hideImagePreview() {
      this.imagePreview.show = false
    }
  },
  computed: {
    filteredProductPrices() {
      if (this.selectedBrandId === 'ALL') return this.productPrices
      return this.productPrices.filter(pp => {
        const prod = this.productDetails[pp.productId]
        const brandId = prod?.brandId || pp.brandId || pp.productBrandId
        return brandId === this.selectedBrandId
      })
    }
  }
}
</script>

<style scoped>
</style>
