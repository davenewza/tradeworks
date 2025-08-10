<template>
  <div class="card">
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-2xl font-semibold text-gray-900">Delivery Addresses</h2>
        <p class="text-gray-600">Manage your saved delivery addresses</p>
      </div>
      <button @click="$emit('close')" class="btn btn-secondary" title="Close">
        Close
      </button>
    </div>

    <!-- Create / Edit Form (collapsed by default) -->
    <div class="mb-6">
      <button 
        v-if="!isFormOpen" 
        @click="openCreateForm" 
        class="btn btn-primary"
      >
        Add New Address
      </button>
      <div v-else class="border border-gray-200 rounded-lg p-4 bg-gray-50">
        <div class="flex items-start justify-between mb-3">
          <h3 class="text-lg font-medium text-gray-900">{{ editingAddress ? 'Edit Address' : 'Add New Address' }}</h3>
          <button @click="cancelForm" class="btn btn-secondary btn-sm">Cancel</button>
        </div>
        <p class="text-xs text-gray-600 mb-3">Fields marked with <span class="text-red-600">*</span> are required.</p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Name <span class="text-red-600">*</span></label>
          <input v-model="form.name" type="text" class="input w-full" placeholder="e.g., Warehouse, Office" required />
          <p v-if="submitAttempted && !form.name" class="mt-1 text-xs text-red-600">Name is required</p>
        </div>
        <div class="md:col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">Organisation</label>
          <input v-model="form.organisation" type="text" class="input w-full" placeholder="e.g., Acme Ltd" />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Contact Person</label>
          <input v-model="form.contactPerson" type="text" class="input w-full" placeholder="e.g., Jane Doe" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Contact Phone</label>
          <input v-model="form.contactPhone" type="tel" class="input w-full" placeholder="e.g., 082 123 4567" />
        </div>
        <div class="md:col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">Contact Email</label>
          <input v-model="form.contactEmail" type="email" class="input w-full" placeholder="e.g., jane@example.com" />
        </div>
        
        <div class="md:col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">Address Line 1 <span class="text-red-600">*</span></label>
          <input v-model="form.addressLine1" type="text" class="input w-full" required />
          <p v-if="submitAttempted && !form.addressLine1" class="mt-1 text-xs text-red-600">Address Line 1 is required</p>
        </div>
        <div class="md:col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">Address Line 2</label>
          <input v-model="form.addressLine2" type="text" class="input w-full" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Suburb <span class="text-red-600">*</span></label>
          <input v-model="form.suburb" type="text" class="input w-full" required />
          <p v-if="submitAttempted && !form.suburb" class="mt-1 text-xs text-red-600">Suburb is required</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">City <span v-if="!editingAddress" class="text-red-600">*</span></label>
          <input v-model="form.city" type="text" class="input w-full" :disabled="!!editingAddress" />
          <p v-if="submitAttempted && !form.city" class="mt-1 text-xs text-red-600">City is required</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Province <span v-if="!editingAddress" class="text-red-600">*</span></label>
          <input v-model="form.province" type="text" class="input w-full" :disabled="!!editingAddress" />
          <p v-if="submitAttempted && !form.province" class="mt-1 text-xs text-red-600">Province is required</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Postal Code <span v-if="!editingAddress" class="text-red-600">*</span></label>
          <input v-model="form.postalCode" type="text" class="input w-full" :disabled="!!editingAddress" />
          <p v-if="submitAttempted && !form.postalCode" class="mt-1 text-xs text-red-600">Postal Code is required</p>
        </div>
        <div class="md:col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">Delivery Notes</label>
          <input v-model="form.deliveryNotes" type="text" class="input w-full" />
        </div>
        </div>
        <div class="mt-4 flex items-center gap-3">
          <button @click="saveAddress" class="btn btn-primary" :disabled="saving || !isFormValid" :class="{ 'opacity-50 cursor-not-allowed': saving || !isFormValid }">
            {{ saving ? (editingAddress ? 'Saving...' : 'Creating...') : (editingAddress ? 'Save Changes' : 'Create Address') }}
          </button>
          <button @click="cancelForm" class="btn btn-secondary">Cancel</button>
        </div>
      </div>
    </div>

    <!-- List -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-lg font-medium text-gray-900">Saved Addresses</h3>
        <span class="text-sm text-gray-600">{{ addresses.length }} total</span>
      </div>

      <div v-if="loading" class="flex justify-center items-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
      <div v-else-if="error" class="bg-red-50 border border-red-200 text-red-800 rounded p-3">{{ error }}</div>
      <div v-else-if="addresses.length === 0" class="text-center text-gray-600 py-10">No active addresses.</div>

      <div v-else class="space-y-3">
        <div v-for="address in addresses" :key="address.id" class="border border-gray-200 rounded-lg p-4">
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center gap-2">
              <h4 class="text-base font-semibold text-gray-900">{{ address.name || 'Address' }}</h4>
              <span v-if="address.isActive === false" class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">Inactive</span>
            </div>
            <div class="flex items-center gap-2">
              <button @click="startEdit(address)" class="btn btn-secondary btn-sm">Edit</button>
              <button @click="deactivate(address)" class="btn btn-danger btn-sm" :disabled="deactivatingId === address.id">
                {{ deactivatingId === address.id ? 'Deactivating...' : 'Deactivate' }}
              </button>
            </div>
          </div>
          <div class="md:grid md:grid-cols-2 md:gap-6">
            <!-- Left: Name/Org/Contact -->
            <div class="space-y-1">
              <p v-if="address.organisation" class="text-sm text-gray-700">{{ address.organisation }}</p>
              <div v-if="address.contactPerson || address.contactPhone || address.contactEmail" class="space-y-0.5">
                <p v-if="address.contactPerson" class="text-sm text-gray-700">Contact: {{ address.contactPerson }}</p>
                <p v-if="address.contactPhone" class="text-sm text-gray-700">Phone: {{ address.contactPhone }}</p>
                <p v-if="address.contactEmail" class="text-sm text-gray-700">Email: {{ address.contactEmail }}</p>
              </div>
            </div>
            <!-- Right: Physical Address -->
            <div class="space-y-1 mt-3 md:mt-6">
              <p class="text-sm text-gray-700">{{ address.addressLine1 }}</p>
              <p v-if="address.addressLine2" class="text-sm text-gray-700">{{ address.addressLine2 }}</p>
              <p class="text-sm text-gray-700">{{ address.suburb }}, {{ address.city }}, {{ address.province }} {{ address.postalCode }}</p>
              <p v-if="address.deliveryNotes" class="text-sm text-gray-700">{{ address.deliveryNotes }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { deliveryAddressService } from '../services/deliveryAddressService.js'

export default {
  name: 'DeliveryAddresses',
  emits: ['close'],
  props: {
    customerId: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      loading: false,
      saving: false,
      submitAttempted: false,
      error: null,
      addresses: [],
      editingAddress: null,
      deactivatingId: null,
      isFormOpen: false,
      form: {
        name: '',
        organisation: '',
        contactPerson: '',
        contactPhone: '',
        contactEmail: '',
        addressLine1: '',
        addressLine2: '',
        deliveryNotes: '',
        suburb: '',
        city: '',
        province: '',
        postalCode: ''
      }
    }
  },
  computed: {
    isFormValid() {
      const required = [
        this.form.name,
        this.form.addressLine1,
        this.form.suburb,
        (!this.editingAddress ? this.form.city : 'ok'),
        (!this.editingAddress ? this.form.province : 'ok'),
        (!this.editingAddress ? this.form.postalCode : 'ok')
      ]
      return required.every(v => typeof v === 'string' && v.trim().length > 0)
    }
  },
  async mounted() {
    await this.loadAddresses()
  },
  methods: {
    async loadAddresses() {
      try {
        this.loading = true
        this.error = null
        const result = await deliveryAddressService.listDeliveryAddresses(this.customerId)
        this.addresses = Array.isArray(result) ? result : (result.results || [])
      } catch (err) {
        this.error = err.message || 'Failed to load delivery addresses'
      } finally {
        this.loading = false
      }
    },
    resetForm() {
      this.editingAddress = null
      this.form = {
        name: '',
        organisation: '',
        contactPerson: '',
        contactPhone: '',
        contactEmail: '',
        addressLine1: '',
        addressLine2: '',
        deliveryNotes: '',
        suburb: '',
        city: '',
        province: '',
        postalCode: ''
      }
    },
    openCreateForm() {
      this.resetForm()
      this.isFormOpen = true
      this.submitAttempted = false
    },
    cancelForm() {
      this.isFormOpen = false
      this.editingAddress = null
      this.submitAttempted = false
    },
    startEdit(address) {
      this.editingAddress = address
      this.form = {
        name: address.name || '',
        organisation: address.organisation || '',
        contactPerson: address.contactPerson || '',
        contactPhone: address.contactPhone || '',
        contactEmail: address.contactEmail || '',
        addressLine1: address.addressLine1 || '',
        addressLine2: address.addressLine2 || '',
        deliveryNotes: address.deliveryNotes || '',
        suburb: address.suburb || '',
        city: address.city || '',
        province: address.province || '',
        postalCode: address.postalCode || ''
      }
      window.scrollTo({ top: 0, behavior: 'smooth' })
      this.isFormOpen = true
    },
    async saveAddress() {
      try {
        this.submitAttempted = true
        if (!this.isFormValid) {
          return
        }
        this.saving = true
        this.error = null
        if (this.editingAddress) {
          // Only send allowed fields on update
          const { name, organisation, contactPerson, contactPhone, contactEmail, addressLine1, addressLine2, suburb, deliveryNotes } = this.form
          await deliveryAddressService.updateDeliveryAddress(this.editingAddress.id, { name, organisation, contactPerson, contactPhone, contactEmail, addressLine1, addressLine2, suburb, deliveryNotes })
        } else {
          await deliveryAddressService.createDeliveryAddress({ ...this.form }, this.customerId)
        }
        await this.loadAddresses()
        this.resetForm()
        this.submitAttempted = false
        this.isFormOpen = false
      } catch (err) {
        this.error = err.message || 'Failed to save address'
      } finally {
        this.saving = false
      }
    },
    async deactivate(address) {
      if (!confirm('Deactivate this address?')) return
      try {
        this.deactivatingId = address.id
        await deliveryAddressService.deactivateDeliveryAddress(address.id)
        await this.loadAddresses()
      } catch (err) {
        this.error = err.message || 'Failed to deactivate address'
      } finally {
        this.deactivatingId = null
      }
    }
  }
}
</script>


