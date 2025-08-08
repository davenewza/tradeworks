# Vercel Deployment Guide

This guide explains how to deploy the CREATESPACE Quote Generation System to Vercel with proper environment variable configuration.

## Prerequisites

- A Vercel account
- Your backend API deployed and accessible via HTTPS
- Git repository with your frontend code

## Deployment Steps

### 1. Connect Your Repository

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click "New Project"
3. Import your Git repository
4. Select the repository containing your frontend code

### 2. Configure Build Settings

Vercel should automatically detect this as a Vite project, but verify these settings:

- **Framework Preset**: Vite
- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- **Install Command**: `npm install`

### 3. Set Environment Variables

**This is the most important step!**

1. In your Vercel project dashboard, go to **Settings** → **Environment Variables**
2. Add a new environment variable:
   - **Name**: `VITE_API_URL`
   - **Value**: Your production backend API URL (e.g., `https://your-backend-domain.com`)
   - **Environment**: Select all environments (Production, Preview, Development)

**Example:**
```
Name: VITE_API_URL
Value: https://api.thecreatespace.co.za
Environment: Production, Preview, Development
```

### 4. Deploy

1. Click "Deploy" in Vercel
2. Wait for the build to complete
3. Your application will be available at the provided Vercel URL

## Verification

After deployment, verify that:

1. **Authentication works**: Try logging in with valid credentials
2. **API calls succeed**: Check browser developer tools for successful API requests
3. **No localhost references**: The built JavaScript should not contain `localhost:8000`

## Troubleshooting

### Issue: API calls still going to localhost:8000

**Cause**: Environment variable not set or not set correctly
**Solution**: 
1. Check Vercel environment variables in project settings
2. Ensure `VITE_API_URL` is set to your production API URL
3. Redeploy the application

### Issue: Build fails

**Cause**: Missing dependencies or build errors
**Solution**:
1. Check build logs in Vercel dashboard
2. Ensure all dependencies are in `package.json`
3. Verify Node.js version compatibility

### Issue: CORS errors

**Cause**: Backend not configured to allow requests from Vercel domain
**Solution**:
1. Update your backend CORS configuration to include your Vercel domain
2. Add `https://your-app.vercel.app` to allowed origins

## Environment Variable Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API URL | `https://api.thecreatespace.co.za` |

## Security Notes

- Never commit `.env` files to your repository
- Use environment variables for all sensitive configuration
- Ensure your backend API is properly secured with authentication
- Use HTTPS for all production API endpoints

## Support

If you encounter issues:
1. Check Vercel build logs
2. Verify environment variables are set correctly
3. Test API endpoints directly
4. Check browser console for JavaScript errors
