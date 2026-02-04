<template>
  <div>
    <!-- Loading State -->
    <div v-if="loading" class="flex justify-center items-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="card">
      <div class="text-center">
        <div class="text-red-600 text-lg font-medium mb-2">Error</div>
        <p class="text-gray-600 mb-4">{{ error }}</p>
        <button @click="loadCustomerPriceLists" class="btn btn-primary">Try Again</button>
      </div>
    </div>

    <!-- Quote Detail View -->
    <div v-else-if="selectedQuote">
      <QuoteDetail 
        :quote="selectedQuote" 
        :customer-id="customerId"
        @back="selectedQuote = null"
        @quote-updated="handleQuoteUpdated"
        @quote-deleted="handleQuoteDeleted"
      />
    </div>

    <!-- Price List View -->
    <div v-else-if="selectedPriceList">
      <PriceListView 
        :price-list="selectedPriceList"
        @close="selectedPriceList = null"
      />
    </div>

    <!-- Main Content -->
    <div v-else>
      <div class="mb-6"></div>

      <!-- Price Lists -->
      <div v-if="priceLists.length === 0" class="card text-center py-12">
        <div class="text-gray-500 mb-4">
          <svg class="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
          </svg>
        </div>
        <h3 class="text-lg font-medium text-gray-900 mb-2">No price lists assigned</h3>
        <p class="text-gray-600 mb-4">You don't have any price lists assigned to your account.</p>
      </div>

      <div v-else class="space-y-8">
        <div 
          v-for="priceList in priceLists" 
          :key="priceList.id" 
          class="card"
        >
          <div class="flex justify-between items-start mb-6">
            <div>
              <h3 class="text-xl font-semibold text-gray-900 mb-1">{{ priceList.name }}</h3>
              <p v-if="priceList.description" class="text-sm text-gray-700 mb-1">{{ priceList.description }}</p>
              <p class="text-sm text-gray-600">
                Created: {{ formatDate(priceList.createdAt) }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button 
                @click="viewPriceList(priceList)"
                class="btn btn-secondary text-sm"
                title="View Price List"
              >
                View Price List
              </button>
              <button 
                @click="createQuoteFromPriceList(priceList)"
                class="btn btn-primary text-sm"
                title="Start New Quote"
              >
                Start New Quote
              </button>
            </div>
          </div>
          
          <!-- Quotes Section -->
          <div class="border-t pt-4">
            <div class="flex justify-between items-center mb-4">
              <h4 class="text-lg font-medium text-gray-900">Quotes</h4>
              <span class="text-sm text-gray-600">{{ quotes[priceList.customerPriceListId]?.length || 0 }} quotes</span>
            </div>

            <!-- Status Filter -->
            <div class="flex flex-wrap items-center gap-2 mb-4">
              <button
                class="px-3 py-1.5 rounded-full text-xs font-medium border"
                :class="statusFilters[priceList.customerPriceListId] === 'All' ? 'bg-gray-800 text-white border-gray-800' : 'text-gray-700 border-gray-300 hover:border-gray-400'"
                @click="setStatusFilter(priceList.customerPriceListId, 'All')"
              >
                All ({{ getStatusCounts(priceList.customerPriceListId).all }})
              </button>
              <button
                class="px-3 py-1.5 rounded-full text-xs font-medium border"
                :class="statusFilters[priceList.customerPriceListId] === 'Draft' ? 'bg-yellow-500 text-white border-yellow-500' : 'text-yellow-800 border-yellow-300 hover:border-yellow-400'"
                @click="setStatusFilter(priceList.customerPriceListId, 'Draft')"
              >
                Draft ({{ getStatusCounts(priceList.customerPriceListId).Draft }})
              </button>
              <button
                class="px-3 py-1.5 rounded-full text-xs font-medium border"
                :class="statusFilters[priceList.customerPriceListId] === 'Submitted' ? 'bg-blue-600 text-white border-blue-600' : 'text-blue-800 border-blue-300 hover:border-blue-400'"
                @click="setStatusFilter(priceList.customerPriceListId, 'Submitted')"
              >
                Submitted ({{ getStatusCounts(priceList.customerPriceListId).Submitted }})
              </button>
              <button
                class="px-3 py-1.5 rounded-full text-xs font-medium border"
                :class="statusFilters[priceList.customerPriceListId] === 'Approved' ? 'bg-green-600 text-white border-green-600' : 'text-green-800 border-green-300 hover:border-green-400'"
                @click="setStatusFilter(priceList.customerPriceListId, 'Approved')"
              >
                Approved ({{ getStatusCounts(priceList.customerPriceListId).Approved }})
              </button>
              <div class="ml-auto w-full md:w-64">
                <input
                  :value="searchTerms[priceList.customerPriceListId] || ''"
                  @input="setSearchTerm(priceList.customerPriceListId, $event.target.value)"
                  type="text"
                  class="input h-9 text-sm"
                  placeholder="Search quotes..."
                />
              </div>
            </div>
            
            <div v-if="!getFilteredQuotes(priceList.customerPriceListId).length" class="text-center py-6">
              <div class="text-gray-500 mb-2">
                <svg class="w-8 h-8 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                </svg>
              </div>
              <p class="text-sm text-gray-600">No quotes yet</p>
            </div>
            
            <div v-else class="space-y-3">
              <div 
                v-for="quote in getFilteredQuotes(priceList.customerPriceListId)" 
                :key="quote.id" 
                class="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors cursor-pointer"
                @click="selectQuote(quote)"
              >
                <div class="flex justify-between items-start">
                  <div>
                    <div class="mb-1">
                      <h5 class="font-medium text-gray-900">
                        <template v-if="quote.deliveryAddressName || quote.name">
                          <span v-if="quote.deliveryAddressName">{{ quote.deliveryAddressName }}</span>
                          <span v-if="quote.name"> ({{ quote.name }})</span>
                        </template>
                        <template v-else>
                          Quote #{{ quote.number }}
                        </template>
                      </h5>
                      <div class="flex items-center gap-2 mt-1">
                        <span v-if="quote.deliveryAddressName || quote.name" class="text-sm text-gray-600">#{{ quote.number }}</span>
                        <span :class="[
                          'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                          quote.status === 'Approved'
                            ? 'bg-green-100 text-green-800'
                            : (quote.status === 'Submitted'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-yellow-100 text-yellow-800')
                        ]">
                          {{ formatQuoteStatus(quote.status) }}
                        </span>
                      </div>
                    </div>
                    <p class="text-sm text-gray-600">
                      Created By: {{ quote.createdByName || '—' }}
                    </p>
                    <p class="text-sm text-gray-600">
                      Last updated: {{ formatDate(quote.updatedAt) }}
                    </p>
                  </div>
                  <div class="text-right">
                    <div class="text-lg font-bold text-gray-900">
                      ZAR {{ formatCurrency(quote.total) }}
                    </div>
                    <div class="text-sm text-gray-600">
                      incl. VAT: ZAR {{ formatCurrency(quote.totalInclVat) }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

  <script>
  import { priceListService } from '../services/priceListService.js'
  import QuoteDetail from './QuoteDetail.vue'
  import PriceListView from './PriceListView.vue'

export default {
  name: 'PriceListManager',
  components: {
    QuoteDetail,
    PriceListView
  },
  props: {
    customerId: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      priceLists: [],
      quotes: {},
      loading: false,
      error: null,
      selectedQuote: null,
      selectedPriceList: null,
      lastHiddenTime: null,
      statusFilters: {},
      searchTerms: {},
      searchTimeouts: {}
    }
  },
  beforeUnmount() {
    // Clean up search timeouts
    Object.values(this.searchTimeouts).forEach(timeout => {
      if (timeout) clearTimeout(timeout)
    })
  },
  watch: {
    customerId: {
      immediate: true,
      async handler(newCustomerId, oldCustomerId) {
        if (newCustomerId && newCustomerId !== oldCustomerId) {
          console.log('Customer ID changed, reloading data:', newCustomerId)
          // Reset state and reload data when customer ID changes
          this.selectedQuote = null
          this.selectedPriceList = null
          this.loading = true
          this.error = null
          this.priceLists = []
          this.quotes = {}
          await this.loadCustomerPriceLists()
        }
      }
    }
  },
  async mounted() {
    // Reset state to ensure we always start with the main view
    this.selectedQuote = null
    this.selectedPriceList = null
    this.loading = true
    this.error = null
    this.priceLists = []
    this.quotes = {}
    
    // Add a timeout to prevent infinite loading
    const timeout = setTimeout(() => {
      if (this.loading) {
        console.error('Loading timeout - forcing loading to false')
        this.loading = false
        this.error = 'Loading timeout - please refresh the page'
      }
    }, 10000) // 10 second timeout
    
    try {
      console.log('PriceListManager mounted - loading fresh data for customer:', this.customerId)
      await this.loadCustomerPriceLists()
    } finally {
      clearTimeout(timeout)
    }
    
    // Add event listener for page visibility changes to refresh data when user returns to the tab
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
  },
  
  beforeUnmount() {
    // Clean up event listener
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
  },
  methods: {
    async hydrateCreatorsForList(cplId) {
      try {
        const list = this.quotes[cplId] || []
        const missing = list.filter(q => (q.createdById || q.createdBy) && !q.createdByName)
        if (missing.length === 0) return

        const { userService } = await import('../services/userService.js')

        // Collect unique user IDs to avoid redundant fetches
        const uniqueUserIds = [...new Set(missing.map(q => q.createdById || q.createdBy))]

        // Fetch all unique users in parallel
        const userMap = new Map()
        await Promise.all(uniqueUserIds.map(async id => {
          try {
            const u = await userService.getUser(id)
            userMap.set(id, u)
          } catch (error) {
            console.warn(`Failed to fetch user ${id}:`, error)
          }
        }))

        // Update quotes with fetched user data
        missing.forEach(q => {
          const id = q.createdById || q.createdBy
          const u = userMap.get(id)
          if (u) {
            q.createdByName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id
          }
        })

        // Force reactive update only if we actually updated something
        if (userMap.size > 0) {
          this.quotes = { ...this.quotes }
        }
      } catch (e) {
        console.warn('Failed to hydrate creator names', e)
      }
    },
    getStatusCounts(cplId) {
      const list = this.quotes[cplId] || []
      const counts = { Draft: 0, Submitted: 0, Approved: 0 }
      for (const q of list) {
        const s = (q.status || 'Draft')
        if (s in counts) counts[s]++
      }
      return { ...counts, all: list.length }
    },
    setStatusFilter(cplId, value) {
      this.$set ? this.$set(this.statusFilters, cplId, value) : (this.statusFilters = { ...this.statusFilters, [cplId]: value })
    },
    getFilteredQuotes(cplId) {
      const list = this.quotes[cplId] || []
      const filter = this.statusFilters[cplId] || 'All'
      // Backend search handles text filtering, only apply status filter here
      return filter === 'All' ? list : list.filter(q => (q.status || 'Draft') === filter)
    },
    setSearchTerm(cplId, value) {
      // Update search term
      this.$set ? this.$set(this.searchTerms, cplId, value) : (this.searchTerms = { ...this.searchTerms, [cplId]: value })

      // Clear existing timeout for this price list
      if (this.searchTimeouts[cplId]) {
        clearTimeout(this.searchTimeouts[cplId])
      }

      // Debounce the search - wait 300ms after user stops typing
      this.searchTimeouts[cplId] = setTimeout(() => {
        this.loadQuotesForSinglePriceList(cplId)
      }, 300)
    },
    handleVisibilityChange() {
      // Refresh data when user returns to the tab (after being away for more than 30 seconds)
      if (!document.hidden && this.lastHiddenTime && (Date.now() - this.lastHiddenTime > 30000)) {
        console.log('User returned to tab after being away, refreshing data')
        this.refreshData()
      }
      this.lastHiddenTime = document.hidden ? Date.now() : null
    },
    
    async refreshData() {
      console.log('Refreshing all data...')
      this.loading = true
      this.error = null
      try {
        await this.loadCustomerPriceLists()
      } catch (error) {
        console.error('Error refreshing data:', error)
        this.error = 'Failed to refresh data'
      } finally {
        this.loading = false
      }
    },
    
    async loadCustomerPriceLists() {
      this.loading = true
      this.error = null
      
      try {
        console.log('Loading customer price lists for customer:', this.customerId)
        const customerPriceLists = await priceListService.getCustomerPriceLists(this.customerId)
        console.log('Customer price lists:', customerPriceLists)
        
        if (!customerPriceLists || customerPriceLists.length === 0) {
          console.log('No customer price lists found')
          this.priceLists = []
          this.loading = false
          return
        }
        
        // Price list data is now embedded in customerPriceList via @embed(priceList)
        // No need to fetch separately
        this.priceLists = customerPriceLists.map((customerPriceList) => {
          // Use embedded priceList data
          const priceList = customerPriceList.priceList || {}
          return {
            ...priceList,
            customerPriceListId: customerPriceList.id,
            // Keep the priceListId for backward compatibility
            priceListId: priceList.id
          }
        })
        console.log('Price lists loaded:', this.priceLists)
        
        // Load quotes for each customer price list
        await this.loadQuotesForPriceLists()
      } catch (err) {
        console.error('Error loading customer price lists:', err)
        this.error = err.message || 'Failed to load price lists'
        // Set empty arrays to prevent further errors
        this.priceLists = []
        this.quotes = {}
      } finally {
        this.loading = false
      }
    },
    
    async loadQuotesForPriceLists() {
      try {
        console.log('Loading quotes for price lists...')
        const { quoteService } = await import('../services/quoteService.js')

        for (const priceList of this.priceLists) {
          console.log('Loading quotes for price list:', priceList.customerPriceListId)
          const searchTerm = this.searchTerms[priceList.customerPriceListId] || null
          const quotes = await quoteService.getQuotesByCustomerPriceList(priceList.customerPriceListId, searchTerm)
          this.quotes[priceList.customerPriceListId] = quotes
          console.log('Quotes loaded for price list:', priceList.customerPriceListId, quotes)
          // Hydrate creator names for this list
          this.hydrateCreatorsForList(priceList.customerPriceListId)
        }
        console.log('All quotes loaded:', this.quotes)
      } catch (err) {
        console.error('Failed to load quotes:', err)
        // Don't let quote loading errors prevent the page from loading
        this.error = 'Failed to load some quotes, but price lists are available'
      }
    },
    async loadQuotesForSinglePriceList(cplId) {
      try {
        const { quoteService } = await import('../services/quoteService.js')
        const searchTerm = this.searchTerms[cplId] || null
        const quotes = await quoteService.getQuotesByCustomerPriceList(cplId, searchTerm)
        this.quotes[cplId] = quotes
        // Hydrate creator names for this list
        this.hydrateCreatorsForList(cplId)
      } catch (err) {
        console.error('Failed to load quotes for price list:', cplId, err)
      }
    },
    
    viewPriceList(priceList) {
      this.selectedPriceList = priceList
    },
    
    async createQuoteFromPriceList(priceList) {
      try {
        const { quoteService } = await import('../services/quoteService.js')
        const newQuote = await quoteService.createQuote(priceList.customerPriceListId)
        
        // Add the new quote to the list
        if (!this.quotes[priceList.customerPriceListId]) {
          this.quotes[priceList.customerPriceListId] = []
        }
        this.quotes[priceList.customerPriceListId].unshift(newQuote)
        
        // Select the new quote
        this.selectQuote(newQuote)
      } catch (err) {
        this.error = err.message || 'Failed to create quote'
      }
    },
    
    selectQuote(quote) {
      this.selectedQuote = quote
    },
    
    handleQuoteUpdated(updatedQuote) {
      // Update the quote in the list
      const priceListId = updatedQuote.customerPriceListId
      if (this.quotes[priceListId]) {
        const index = this.quotes[priceListId].findIndex(q => q.id === updatedQuote.id)
        if (index !== -1) {
          this.quotes[priceListId][index] = updatedQuote
        }
      }
      this.selectedQuote = updatedQuote
    },
    
    handleQuoteDeleted() {
      // Remove the quote from the list
      const priceListId = this.selectedQuote.customerPriceListId
      if (this.quotes[priceListId]) {
        this.quotes[priceListId] = this.quotes[priceListId].filter(q => q.id !== this.selectedQuote.id)
      }
      this.selectedQuote = null
    },
    
    formatDate(dateString) {
      if (!dateString) return '—'
      const d = new Date(dateString)
      const day = String(d.getDate()).padStart(2, '0')
      const month = d.toLocaleString('en-GB', { month: 'short' })
      const year = d.getFullYear()
      return `${day} ${month} ${year}`
    },
    
    formatCurrency(amount) {
      if (!amount) return '0.00'
      return parseFloat(amount).toLocaleString('en-ZA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    },

    formatQuoteStatus(status) {
      const s = status || 'Draft'
      if (s === 'Approved') return 'Approved'
      if (s === 'Submitted') return 'Submitted'
      return 'Draft'
    }
  }
}
</script>
