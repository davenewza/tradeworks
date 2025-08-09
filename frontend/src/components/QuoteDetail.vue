<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex justify-between items-center">
      <div class="flex items-center space-x-4">
        <button @click="$emit('back')" class="btn btn-secondary">
          Back to Quotes
        </button>
        <h2 class="text-2xl font-semibold text-gray-900">Quote #{{ quote.number }}</h2>
      </div>
      <div class="flex space-x-2">
        <button 
          v-if="quote.status === 'Draft' || !quote.status" 
          @click="submitQuote" 
          class="btn bg-green-600 hover:bg-green-700 text-white"
          :disabled="isSubmitDisabled"
          :class="{ 'opacity-50 cursor-not-allowed': isSubmitDisabled }"
        >
          <span v-if="submittingQuote" class="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></span>
          {{ submittingQuote ? 'Submitting...' : 'Submit Quote' }}
        </button>
        <button @click="deleteQuote" class="btn btn-danger">
          Delete Quote
        </button>
      </div>
    </div>

    <!-- Quote Info -->
    <div class="card">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Quote Number</label>
          <p class="text-lg font-semibold text-gray-900">{{ quote.number }}</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Status</label>
          <div class="flex items-center">
            <span :class="[
              'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
              quote.status === 'Submitted' 
                ? 'bg-green-100 text-green-800' 
                : 'bg-yellow-100 text-yellow-800'
            ]">
              {{ formatQuoteStatus(quote.status) }}
            </span>
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Created</label>
          <p class="text-gray-900">{{ formatDate(quote.createdAt) }}</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Last Updated</label>
          <p class="text-gray-900">{{ formatDate(quote.updatedAt) }}</p>
        </div>
      </div>
    </div>

    <!-- Delivery Address Selection -->
    <div class="card">
      <div class="flex items-center justify-between mb-2">
        <label class="block text-sm font-medium text-gray-700">Delivery Address <span class="text-red-600" v-if="!productsReadOnly">*</span></label>
        <span v-if="!productsReadOnly && addressSubmitAttempted && !selectedAddressId" class="text-xs text-red-600">Address is required</span>
      </div>
      <div class="flex items-center gap-3">
        <select 
          class="input w-full md:w-1/2" 
          v-model="selectedAddressId"
          :disabled="productsReadOnly || loadingAddresses"
          @change="onAddressChange"
        >
          <option value="" disabled>Select an address</option>
          <option v-for="addr in deliveryAddresses" :key="addr.id" :value="addr.id">
            {{ addr.organisation ? addr.organisation + ' — ' : '' }}{{ addr.name }} — {{ addr.addressLine1 }}, {{ addr.suburb }}, {{ addr.city }}
          </option>
        </select>
        <button class="btn btn-secondary" @click="$emit('back')" v-if="false">Manage Addresses</button>
      </div>
    </div>

    <!-- Products Section -->
    <div class="card">

      <!-- Products List -->
      <div v-if="quoteProducts.length === 0" class="text-center py-8">
        <div class="text-gray-500 mb-4">
          <svg class="w-12 h-12 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21h18"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21v-4h6"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 7l3 3-3 3-3-3 3-3z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 6l3 3"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10h3"/>
          </svg>
        </div>
        <h4 class="text-lg font-medium text-gray-900 mb-2">No products added</h4>
        <p class="text-gray-600">Add products to this quote to get started.</p>
      </div>

      <div v-else class="space-y-4">
        <!-- Column Headers -->
        <div class="flex justify-between items-center px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg">
          <div class="flex items-center space-x-4">
            <div class="min-h-[2rem] flex flex-col justify-center">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Product</h4>
            </div>
          </div>
          <div class="flex items-center space-x-4">
            <div class="w-12 text-center">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide"></h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Quantity</h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Price</h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Total</h4>
            </div>
          </div>
        </div>
        
        <div 
          v-for="product in quoteProducts" 
          :key="product.id" 
          class="border border-gray-200 rounded-lg p-2 hover:bg-gray-50 transition-colors"
        >
          <div class="flex justify-between items-center">
              <div class="flex items-center space-x-4">
              <div class="relative w-12 h-12">
                <img 
                  v-if="productDetails[product.productId]?.image?.url" 
                  :src="productDetails[product.productId].image.url" 
                  :alt="productDetails[product.productId]?.name"
                  class="w-12 h-12 object-contain rounded-lg cursor-pointer bg-white"
                  @mouseenter="showImagePreview(product.productId, $event)"
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
                <h4 class="font-medium text-gray-900">{{ productDetails[product.productId]?.name || 'Product' }}</h4>
                <p class="text-sm text-gray-600">SKU: {{ productDetails[product.productId]?.sku || 'N/A' }}</p>
              </div>
            </div>
            <div class="flex items-center space-x-4">
              <div class="w-12 text-center">
            <button 
                  v-if="!productsReadOnly"
              @click="removeProduct(product.id)" 
                  class="text-red-600 hover:text-red-800 p-2 rounded"
              title="Remove product"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
              </svg>
            </button>
              </div>
              <div class="w-20 text-right">
                <input 
                  v-if="!productsReadOnly"
                  type="number" 
                  :value="product.quantity" 
                  @change="updateProductQuantity(product.id, $event.target.value)"
                  class="input w-16 text-sm text-center"
                  min="0"
                  step="1"
                />
                <p v-else class="text-sm font-medium text-gray-900 text-center">
                  {{ product.quantity }}
                </p>
              </div>
              <div class="w-20 text-right">
                <p class="text-sm font-medium text-gray-900">{{ formatCurrency(product.price) }}</p>
              </div>
              <div class="w-20 text-right">
                <p class="text-sm font-bold text-gray-900">{{ formatCurrency(product.total) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Product Action Buttons -->
      <div class="flex justify-end items-center space-x-3 mt-6 pt-4 border-t border-gray-200">
        <button 
          @click="showAddProductModal = true" 
          class="btn btn-primary"
          :disabled="productsReadOnly"
          :class="{ 'opacity-50 cursor-not-allowed': productsReadOnly }"
        >
          Add Product
        </button>
        <button 
          @click="toggleProductsReadOnly" 
          class="btn btn-secondary"
          :disabled="(!productsReadOnly && (quoteProducts.length === 0 || !selectedAddressId))"
          :class="{ 'opacity-50 cursor-not-allowed': (!productsReadOnly && (quoteProducts.length === 0 || !selectedAddressId)) }"
        >
          {{ productsReadOnly ? 'Edit Products' : 'Continue with Shipping' }}
        </button>
      </div>
    </div>

    <!-- Equipment Boxes Section -->
    <div v-if="productsReadOnly" class="card">
      <div class="mb-4">
        <div class="flex gap-3">
          <button
            type="button"
            @click="selectBoxType('PlasticEquipment')"
            :disabled="loading"
            :class="[
              'flex items-center gap-3 px-3 py-2 rounded-md border transition',
              selectedBoxType === 'PlasticEquipment' ? 'border-blue-600 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
            ]"
          >
            <svg class="w-5 h-5 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="4" y="4" width="16" height="12" rx="2" ry="2" stroke-width="2"/>
              <path d="M4 12h16" stroke-width="2"/>
            </svg>
            <div class="text-left">
              <div class="text-sm font-medium text-gray-900">Plastic Equipment</div>
              <div class="text-xs text-gray-500">Plastic tote box</div>
            </div>
          </button>
          <button
            type="button"
            @click="selectBoxType('Cardboard')"
            :disabled="loading"
            :class="[
              'flex items-center gap-3 px-3 py-2 rounded-md border transition',
              selectedBoxType === 'Cardboard' ? 'border-blue-600 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
            ]"
          >
            <svg class="w-5 h-5 text-yellow-600" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M3 7l9-4 9 4-9 4-9-4z" stroke-width="2"/>
              <path d="M3 7v10l9 4 9-4V7" stroke-width="2"/>
            </svg>
            <div class="text-left">
              <div class="text-sm font-medium text-gray-900">Cardboard</div>
              <div class="text-xs text-gray-500">Plain cardboard box</div>
            </div>
          </button>
        </div>
      </div>

      <!-- Equipment Boxes List -->
      <div v-if="!selectedBoxType" class="text-center py-8">
        <div class="text-gray-500 mb-4">
          <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
          </svg>
        </div>
        <h4 class="text-lg font-medium text-gray-900 mb-2">No equipment boxes selected</h4>
        <p class="text-gray-600">Select a box type to automatically calculate packaging requirements.</p>
      </div>

      <div v-else-if="loadingEquipmentBoxes" class="flex justify-center items-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>

      <div v-else-if="equipmentBoxes.length === 0" class="text-center py-8">
        <div class="text-gray-500 mb-4">
          <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
          </svg>
        </div>
        <h4 class="text-lg font-medium text-gray-900 mb-2">No equipment boxes needed</h4>
        <p class="text-gray-600">The current products don't require any equipment boxes.</p>
      </div>

      <div v-else class="space-y-3">
        <!-- Equipment Box Headers -->
        <div class="flex justify-between items-center px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg">
          <div class="flex items-center space-x-4">
            <div class="min-h-[2rem] flex flex-col justify-center">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Description</h4>
            </div>
          </div>
          <div class="flex items-center space-x-4">
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Quantity</h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Price</h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Total</h4>
            </div>
          </div>
        </div>
        
        <div 
          v-for="equipmentBox in equipmentBoxes" 
          :key="equipmentBox.id" 
          class="border border-gray-200 rounded-lg p-2 hover:bg-gray-50 transition-colors"
        >
          <div class="flex justify-between items-center">
            <div class="flex items-center space-x-4">
              <div class="relative w-12 h-12">
                <img
                  v-if="equipmentBoxDetails[equipmentBox.equipmentBoxId]?.image?.url"
                  :src="equipmentBoxDetails[equipmentBox.equipmentBoxId].image.url"
                  :alt="equipmentBoxDetails[equipmentBox.equipmentBoxId]?.name || 'Equipment Box'"
                  class="w-12 h-12 object-contain rounded-lg cursor-pointer bg-white"
                  @mouseenter="showBoxImagePreview(equipmentBox.equipmentBoxId, $event)"
                  @mousemove="updateImagePreviewPosition($event)"
                  @mouseleave="hideImagePreview"
                />
                <div v-else class="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                  <svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
                  </svg>
                </div>
              </div>
              <div class="min-h-[2rem] flex flex-col justify-center">
                <h4 class="font-medium text-gray-900">
                  {{ equipmentBoxDetails[equipmentBox.equipmentBoxId]?.name || `Equipment Box ${equipmentBox.equipmentBoxId}` }}
                </h4>
                <p class="text-xs text-gray-500">
                  Dimensions: {{ formatDimensions(equipmentBoxDetails[equipmentBox.equipmentBoxId]) }}
                </p>
              </div>
            </div>
                          <div class="flex items-center space-x-4">
                <div class="w-20 text-right">
                  <p class="text-sm font-medium text-gray-900">{{ equipmentBox.quantity }}</p>
                </div>
                <div class="w-20 text-right">
                  <p class="text-sm font-medium text-gray-900">{{ formatCurrency(equipmentBox.price) }}</p>
                </div>
                <div class="w-20 text-right">
                  <p class="text-sm font-bold text-gray-900">{{ formatCurrency(equipmentBox.total) }}</p>
                </div>
              </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Shipping Details Section -->
    <div v-if="productsReadOnly" class="card">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Total Shipment Weight</label>
          <div class="text-2xl font-bold text-gray-900">
            {{ formatWeight(totalShipmentWeight) }}
          </div>
          <p class="text-sm text-gray-600 mt-1">
            Combined weight of all products and equipment boxes
          </p>
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Weight Breakdown</label>
          <div class="space-y-2">
            <div class="flex justify-between text-sm">
              <span class="text-gray-600">Products</span>
              <span class="font-medium">{{ formatWeight(productsWeight) }}</span>
            </div>
            <div v-if="selectedBoxType && equipmentBoxes.length > 0" class="flex justify-between text-sm">
              <span class="text-gray-600">Equipment Boxes</span>
              <span class="font-medium">{{ formatWeight(equipmentBoxesWeight) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Delivery Rates Section -->
      <div class="mt-6 border-t pt-6">
        <div v-if="deliveryRates">
          <!-- Delivery Summary -->
          <div class="bg-green-50 border border-green-200 rounded-lg p-4">
            <div class="flex items-center">
              <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
              </div>
              <div class="ml-3">
                <h3 class="text-sm font-medium text-green-800">The Courier Guy delivery quote</h3>
                                  <div class="mt-2 text-sm text-green-700">
                    <p><strong>{{ deliveryRates.selectedDeliveryService }}</strong> - ZAR {{ formatCurrency(deliveryRates.selectedDeliveryFees) }}</p>
                    <p class="mt-1 text-xs">
                      {{ deliveryRates.totalParcels }} parcels • 
                      Actual Weight {{ deliveryRates.totalWeightKg?.toFixed(2) || '0.00' }} kg
                      <span v-if="deliveryRates.chargedWeight">
                        • Charged Weight {{ deliveryRates.chargedWeight.toFixed(0) }} kg
                      </span>
                    </p>
                  </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Delivery Rates Error -->
      <div v-if="deliveryRatesError" class="mt-6 border-t pt-6">
        <div class="bg-red-50 border border-red-200 rounded-lg p-4">
          <div class="flex">
            <div class="flex-shrink-0">
              <svg class="h-5 w-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="ml-3 flex-1">
              <h3 class="text-sm font-medium text-red-800">Failed to calculate delivery rates</h3>
              <div class="mt-2 text-sm text-red-700">
                <p>{{ deliveryRatesError }}</p>
              </div>
              <div class="mt-3">
                <button 
                  @click="calculateDeliveryRates"
                  :disabled="loadingDeliveryRates"
                  class="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg v-if="loadingDeliveryRates" class="animate-spin -ml-1 mr-2 h-4 w-4 text-red-700" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {{ loadingDeliveryRates ? 'Retrying...' : 'Retry' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Totals Section -->
    <div class="card">
      <div class="flex justify-end">
        <div class="w-80 space-y-2">
          <!-- Products Subtotal -->
          <div class="flex justify-between">
            <span class="text-gray-600">Products</span>
            <span class="font-medium">{{ formatCurrency(quote.totalProductPrice || 0) }}</span>
          </div>
          
                      <!-- Equipment Boxes Subtotal -->
            <div class="flex justify-between">
              <span class="text-gray-600">Equipment Boxes</span>
              <span class="font-medium">{{ quote.totalEquipmentBoxPrice && quote.totalEquipmentBoxPrice > 0 ? formatCurrency(quote.totalEquipmentBoxPrice) : '0.00' }}</span>
            </div>
            
            <!-- Delivery Fees -->
          <div class="flex justify-between">
              <span class="text-gray-600">Delivery</span>
              <span class="font-medium">{{ quote.totalDeliveryFees && quote.totalDeliveryFees > 0 ? formatCurrency(quote.totalDeliveryFees) : '0.00' }}</span>
          </div>
          
          <!-- Grand Total -->
          <div class="border-t pt-2">
            <div class="flex justify-between">
              <span class="text-sm text-gray-600">Total excl. VAT</span>
              <span class="text-sm font-medium text-gray-900">ZAR {{ formatCurrency(grandTotal) }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-lg font-semibold">Total incl. VAT</span>
              <span class="text-lg font-bold text-gray-900">ZAR {{ formatCurrency(grandTotalInclVat) }}</span>
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

    <!-- Add Product Modal -->
    <AddProductModal 
      v-if="showAddProductModal"
      :quote-id="quote.id"
        :price-list-id="customerPriceList?.priceListId"
        :existing-quote-products="quoteProducts"
      @close="showAddProductModal = false"
      @product-added="handleProductAdded"
    />
  </div>
</template>

<script>
import AddProductModal from './AddProductModal.vue'
import { quoteService } from '../services/quoteService.js'
import { productService } from '../services/productService.js'
import { deliveryService } from '../services/deliveryService.js'

export default {
  name: 'QuoteDetail',
  components: {
    AddProductModal
  },
  props: {
    quote: {
      type: Object,
      required: true
    },
    customerId: {
      type: String,
      required: false
    }
  },
  data() {
    return {
      productPrices: [], // The price list
      quoteProducts: [],
      productDetails: {}, // Store product details by productId
      showAddProductModal: false,
      loading: false,
      customerPriceList: null,
      equipmentBoxes: [],
      equipmentBoxDetails: {}, // Store equipment box details by equipmentBoxId
      selectedBoxType: '',
      loadingEquipmentBoxes: false,
      imagePreview: {
        show: false,
        src: '',
        alt: '',
        x: 0,
        y: 0
      },
      deliveryRates: null,
      loadingDeliveryRates: false,
      deliveryRatesError: null,
      submittingQuote: false,
      productsReadOnly: false,
      deliveryAddresses: [],
      loadingAddresses: false,
      selectedAddressId: '',
      addressSubmitAttempted: false
    }
  },
  async mounted() {
    await this.refreshQuoteData()
    await this.loadCustomerPriceList()
    await this.loadQuoteProducts()
    await this.loadProductDetails()
    await this.loadEquipmentBoxes()
    this.initializeBoxType()
    await this.loadDeliveryAddresses()
    // hydrate selected from quote if present
    if (this.quote.deliveryAddressId) {
      this.selectedAddressId = this.quote.deliveryAddressId
    }
    this.checkExistingDeliveryDetails()
    // If delivery already set on quote, lock products and show delivery sections
    if (this.quote.deliveryService && this.quote.totalDeliveryFees && this.quote.totalDeliveryFees > 0) {
      this.productsReadOnly = true
    }
  },
  computed: {
    // Note: Totals are now pulled from the quote response from getQuote
    // and should include equipment boxes and delivery fees from the backend
    isDeliverySet() {
      return !!(this.quote.totalDeliveryFees && this.quote.totalDeliveryFees > 0)
    },
    isSubmitDisabled() {
      return !this.isDeliverySet 
        || !this.productsReadOnly 
        || this.loading 
        || this.loadingEquipmentBoxes 
        || this.loadingDeliveryRates 
        || this.submittingQuote
    },
    grandTotal() {
      return this.quote.total || 0
    },
    vat() {
      return this.quote.vat || 0
    },
    grandTotalInclVat() {
      return this.quote.totalInclVat || 0
    },
    productsWeight() {
      return this.quoteProducts.reduce((totalWeight, quoteProduct) => {
        const product = this.productDetails[quoteProduct.productId]
        if (product && product.weightInGrams) {
          return totalWeight + (Number(product.weightInGrams) * quoteProduct.quantity)
        }
        return totalWeight
      }, 0)
    },
    equipmentBoxesWeight() {
      return this.equipmentBoxes.reduce((totalWeight, equipmentBox) => {
        const equipmentBoxDetail = this.equipmentBoxDetails[equipmentBox.equipmentBoxId]
        if (equipmentBoxDetail && equipmentBoxDetail.weightInGrams) {
          return totalWeight + (Number(equipmentBoxDetail.weightInGrams) * equipmentBox.quantity)
        }
        return totalWeight
      }, 0)
    },
    totalShipmentWeight() {
      return this.productsWeight + this.equipmentBoxesWeight
    }
  },
  watch: {
    // Reset delivery rates when products change
    'quote.products': {
      handler() {
        // Hydrate from backend if delivery details exist to avoid flicker
        this.checkExistingDeliveryDetails()
      },
      deep: true
    },
    // Hydrate delivery details any time the quote object updates from parent
    quote: {
      handler() {
        this.$nextTick(() => {
          this.checkExistingDeliveryDetails()
          // If delivery already set on quote, lock products and show delivery sections
          if (this.quote.deliveryService && this.quote.totalDeliveryFees && this.quote.totalDeliveryFees > 0) {
            this.productsReadOnly = true
          }
        })
      },
      deep: false
    },
    // Reset delivery rates when equipment boxes change
    equipmentBoxes: {
      handler() {
        // Do not clear; hydrate from backend state to prevent flicker/disappear
        this.$nextTick(() => {
          this.checkExistingDeliveryDetails()
        })
      },
      deep: true
    },
    // Update selected box type when quote boxType changes
    'quote.boxType': {
      handler(newBoxType) {
        if (newBoxType && newBoxType !== this.selectedBoxType) {
          this.selectedBoxType = newBoxType
          console.log('Box type updated from quote:', newBoxType)
        }
      },
      immediate: true
    }
  },
  methods: {
    async loadDeliveryAddresses() {
      try {
        if (!this.customerId) return
        this.loadingAddresses = true
        const { deliveryAddressService } = await import('../services/deliveryAddressService.js')
        const result = await deliveryAddressService.listDeliveryAddresses(this.customerId)
        this.deliveryAddresses = Array.isArray(result) ? result : (result.results || [])
      } catch (e) {
        console.error('Failed to load delivery addresses', e)
        this.deliveryAddresses = []
      } finally {
        this.loadingAddresses = false
      }
    },

    async onAddressChange() {
      try {
        // update quote delivery address on change
        await quoteService.updateQuoteDeliveryAddress(this.quote.id, this.selectedAddressId)
        const updatedQuote = await quoteService.getQuote(this.quote.id)
        this.$emit('quote-updated', updatedQuote)
      } catch (e) {
        console.error('Failed to update quote delivery address', e)
        alert('Failed to update delivery address: ' + (e.message || 'Unknown error'))
      }
    },

    selectBoxType(type) {
      if (this.selectedBoxType !== type) {
        this.selectedBoxType = type
        // mimic native change
        this.onBoxTypeChange()
      }
    },
    async toggleProductsReadOnly() {
      if (!this.productsReadOnly) {
        // going into shipping mode; require address
        this.addressSubmitAttempted = true
        if (!this.selectedAddressId) {
          return
        }
      }
      this.productsReadOnly = !this.productsReadOnly
      
      if (this.productsReadOnly && this.selectedBoxType) {
        // If switching to read-only mode, calculate equipment boxes and delivery
        await this.calculateEquipmentBoxes()
        // Calculate delivery rates after equipment boxes are calculated
        if (this.equipmentBoxes.length > 0) {
          await this.calculateDeliveryRates()
        }
      } else if (!this.productsReadOnly) {
        // If switching back to editing mode, reset delivery info
        this.addressSubmitAttempted = false
        await this.resetDeliveryInfo()
      }
    },
    
    async loadCustomerPriceList() {
      try {
        const { priceListService } = await import('../services/priceListService.js')
        // Get the customer price list by its ID to find the actual price list ID
        const customerPriceList = await priceListService.getCustomerPriceList(this.quote.customerPriceListId)
        if (customerPriceList) {
          this.customerPriceList = customerPriceList
        } else {
          // Fallback - assume the customerPriceListId is actually the price list ID
          this.customerPriceList = { priceListId: this.quote.customerPriceListId }
        }
      } catch (err) {
        console.error('Failed to load customer price list:', err)
        // Fallback - assume the customerPriceListId is actually the price list ID
        this.customerPriceList = { priceListId: this.quote.customerPriceListId }
      }
    },
    
    async loadQuoteProducts() {
      try {
        this.quoteProducts = await quoteService.getQuoteProducts(this.quote.id)
      } catch (err) {
        console.error('Failed to load quote products:', err)
      }

      try {
        this.productPrices = await productService.getProductPricesByPriceList(this.customerPriceList.priceListId)
      } catch (err) {
        console.error('Failed to load product prices:', err)
      }
    },
    
    async loadProductDetails() {
      try {
        const { productService } = await import('../services/productService.js')
        for (const quoteProduct of this.quoteProducts) {
          //const productPrice = this.productPrices.find(p => p.id === quoteProduct.productPriceId)

          if (!this.productDetails[quoteProduct.productId]) {
            try {
              this.productDetails[quoteProduct.productId] = await productService.getProduct(quoteProduct.productId)
            } catch (err) {
              console.error(`Failed to load product price ${quoteProduct.productId}:`, err)
            }
          }
        }
      } catch (err) {
        console.error('Failed to load product details:', err)
      }
    },
    
    async updateProductQuantity(productId, quantity) {
      try {
        // Update the backend
        await quoteService.updateQuoteProduct(productId, parseFloat(quantity))
        
        // Reload the quote products list to get updated computed fields
        await this.loadQuoteProducts()
        
        // Refresh quote totals
        const updatedQuote = await quoteService.getQuote(this.quote.id)
        this.$emit('quote-updated', updatedQuote)
      } catch (err) {
        console.error('Failed to update product quantity:', err)
      }
    },
    
    async removeProduct(productId) {
      if (!confirm('Are you sure you want to remove this product from the quote?')) {
        return
      }
      
      try {
        // Delete from backend
        await quoteService.deleteQuoteProduct(productId)
        
        // Reload the quote products list to get updated data
        await this.loadQuoteProducts()
        
        // Refresh quote totals
        const updatedQuote = await quoteService.getQuote(this.quote.id)
        this.$emit('quote-updated', updatedQuote)
      } catch (err) {
        console.error('Failed to remove product:', err)
      }
    },
    
    async deleteQuote() {
      if (!confirm('Are you sure you want to delete this quote? This action cannot be undone.')) {
        return
      }
      
      try {
        await quoteService.deleteQuote(this.quote.id)
        this.$emit('quote-deleted')
      } catch (err) {
        console.error('Failed to delete quote:', err)
      }
    },
    
    async handleProductAdded() {
      this.showAddProductModal = false
      await this.loadQuoteProducts()
      await this.loadProductDetails()
      // Refresh quote totals
      const updatedQuote = await quoteService.getQuote(this.quote.id)
      this.$emit('quote-updated', updatedQuote)
    },
    
    async loadEquipmentBoxes() {
      try {
        this.loadingEquipmentBoxes = true
        const { equipmentBoxService } = await import('../services/equipmentBoxService.js')
        const response = await equipmentBoxService.listQuoteEquipmentBoxes(this.quote.id)
        this.equipmentBoxes = response.results || []
        
        // Load equipment box details for each equipment box
        for (const equipmentBox of this.equipmentBoxes) {
          if (!this.equipmentBoxDetails[equipmentBox.equipmentBoxId]) {
            try {
              this.equipmentBoxDetails[equipmentBox.equipmentBoxId] = await equipmentBoxService.getEquipmentBox(equipmentBox.equipmentBoxId)
            } catch (err) {
              console.error(`Failed to load equipment box details ${equipmentBox.equipmentBoxId}:`, err)
            }
          }
        }
      } catch (err) {
        console.error('Failed to load equipment boxes:', err)
        this.equipmentBoxes = []
      } finally {
        this.loadingEquipmentBoxes = false
      }
    },
    
    async onBoxTypeChange() {
      if (!this.selectedBoxType) {
        // Reset delivery info when no box type is selected
        await this.resetDeliveryInfo()
      } else {
        // Calculate equipment boxes for selected type
        await this.calculateEquipmentBoxes()
        // Calculate delivery rates after equipment boxes are calculated
        if (this.equipmentBoxes.length > 0) {
          await this.calculateDeliveryRates()
        }
      }
    },
    
    async resetDeliveryInfo() {
      try {
        this.loading = true
        const { equipmentBoxService } = await import('../services/equipmentBoxService.js')
        await equipmentBoxService.resetDeliveryInfo(this.quote.id)
        
        // Reset local state
        this.equipmentBoxes = []
        this.deliveryRates = null
        this.deliveryRatesError = null
        
        // Refresh quote data to get updated totals
        await this.refreshQuoteData()
      } catch (err) {
        console.error('Failed to reset delivery info:', err)
        alert('Failed to reset delivery info: ' + err.message)
      } finally {
        this.loading = false
      }
    },
    
    async calculateEquipmentBoxes() {
      if (!this.selectedBoxType) return
      
      try {
        this.loading = true
        const { equipmentBoxService } = await import('../services/equipmentBoxService.js')
        await equipmentBoxService.calculateEquipmentBoxes(this.quote.id, this.selectedBoxType)
        await this.loadEquipmentBoxes()
        
        // Refresh quote data to get updated totals after equipment boxes calculation
        await this.refreshQuoteData()
      } catch (err) {
        console.error('Failed to calculate equipment boxes:', err)
        alert('Failed to calculate equipment boxes: ' + err.message)
      } finally {
        this.loading = false
      }
    },
    
    formatDate(dateString) {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    },
    
    formatCurrency(amount) {
      return parseFloat(amount).toLocaleString('en-ZA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    },
    
    formatVolume(volume) {
      if (!volume) return 'N/A'
      return `${parseFloat(volume).toFixed(0)} cm³`
    },
    
    formatDimensions(equipmentBox) {
      if (!equipmentBox) return 'N/A'
      const { lengthInCm, widthInCm, heightInCm } = equipmentBox
      if (!lengthInCm || !widthInCm || !heightInCm) return 'N/A'
      return `${parseFloat(lengthInCm).toFixed(0)} × ${parseFloat(widthInCm).toFixed(0)} × ${parseFloat(heightInCm).toFixed(0)} cm`
    },
    
    formatWeight(weightInGrams) {
      if (!weightInGrams || weightInGrams === 0) return '0 kg'
      
      const weightInKg = weightInGrams / 1000
      if (weightInKg >= 1) {
        return `${weightInKg.toFixed(2)} kg`
      } else {
        return `${weightInGrams.toFixed(0)} g`
      }
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
    },

    showBoxImagePreview(equipmentBoxId, event) {
      const box = this.equipmentBoxDetails[equipmentBoxId]
      if (box?.image?.url) {
        const offsetX = 10
        const offsetY = 10
        const previewWidth = 250
        const previewHeight = 250
        let x = event.clientX + offsetX
        let y = event.clientY + offsetY
        if (x + previewWidth > window.innerWidth) {
          x = event.clientX - previewWidth - offsetX
        }
        if (y + previewHeight > window.innerHeight) {
          y = event.clientY - previewHeight - offsetY
        }
        this.imagePreview = {
          show: true,
          src: box.image.url,
          alt: box.name || 'Equipment Box',
          x,
          y
        }
      }
    },
    
    resetDeliveryRates() {
      // Reset delivery rates when quote parameters change
      this.deliveryRates = null
      this.deliveryRatesError = null
      this.loadingDeliveryRates = false
    },
    
    async calculateDeliveryRates() {
      if (!this.selectedBoxType || this.equipmentBoxes.length === 0) {
        this.deliveryRatesError = 'Please calculate equipment boxes first before calculating delivery rates.'
        return
      }
      
      this.loadingDeliveryRates = true
      this.deliveryRatesError = null
      this.deliveryRates = null
      
      try {
        const response = await deliveryService.calculateDelivery(this.quote.id)
        
        // Extract the charged weight from the cheapest rate (first in availableRates)
        const chargedWeight = response.availableRates && response.availableRates.length > 0 
          ? response.availableRates[0].weights.chargedWeight 
          : null
        
        this.deliveryRates = {
          ...response,
          chargedWeight: chargedWeight
        }
        
        // Refresh quote data to get updated totals after successful delivery calculation
        await this.refreshQuoteData()
      } catch (error) {
        console.error('Failed to calculate delivery rates:', error)
        this.deliveryRatesError = error.message || 'Failed to calculate delivery rates'
      } finally {
        this.loadingDeliveryRates = false
      }
    },
    
    formatDeliveryDate(dateString) {
      if (!dateString) return 'N/A'
      
      try {
        const date = new Date(dateString)
        return date.toLocaleDateString('en-ZA', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        })
      } catch (error) {
        console.error('Error formatting delivery date:', error)
        return 'Invalid date'
      }
    },

    formatQuoteStatus(status) {
      if (!status) return 'Draft'
      return status === 'Submitted' ? 'Submitted' : 'Draft'
    },

    async refreshQuoteData() {
      try {
        // Refresh the quote data from the backend
        const refreshedQuote = await quoteService.getQuote(this.quote.id)
        
        // Update local quote data
        
        // Emit the updated quote to parent component
        this.$emit('quote-updated', refreshedQuote)
        
        // Ensure UI updates after quote data change
        await this.$nextTick()
        
        console.log('Quote data refreshed successfully')
      } catch (error) {
        console.error('Failed to refresh quote data:', error)
        // Don't show alert here as it might be too intrusive
        // The quote will still work with the existing data
      }
    },

    initializeBoxType() {
      // Set the box type based on the quote's boxType field
      if (this.quote.boxType) {
        this.selectedBoxType = this.quote.boxType
        console.log('Initialized box type from quote:', this.quote.boxType)
      }
    },

    checkExistingDeliveryDetails() {
      // Check if the quote already has delivery details set
      if (this.quote.deliveryService && this.quote.totalDeliveryFees && this.quote.totalDeliveryFees > 0) {
        // Hydrate the delivery rates with existing data
        this.deliveryRates = {
          selectedDeliveryService: this.quote.deliveryService,
          selectedDeliveryFees: this.quote.totalDeliveryFees,
          // We'll need to calculate these from equipment boxes if available
          totalParcels: this.equipmentBoxes.length > 0 ? this.equipmentBoxes.reduce((sum, box) => sum + box.quantity, 0) : 0,
          totalWeightKg: this.totalShipmentWeight / 1000, // Convert from grams to kg
          totalVolumeCm3: this.equipmentBoxes.length > 0 ? this.equipmentBoxes.reduce((sum, box) => {
            const equipmentBoxDetail = this.equipmentBoxDetails[box.equipmentBoxId]
            if (equipmentBoxDetail) {
              const volume = (equipmentBoxDetail.lengthInCm * equipmentBoxDetail.widthInCm * equipmentBoxDetail.heightInCm) * box.quantity
              return sum + volume
            }
            return sum
          }, 0) : 0
          // Note: chargedWeight is only available after fresh delivery calculation
          // For existing delivery details, we don't have the charged weight from the API
        }
        console.log('Hydrated existing delivery details:', this.deliveryRates)
      } else {
        console.log('No existing delivery details found')
      }
    },

    async submitQuote() {
      alert('This is not available yet')
    }
  }
}
</script>
