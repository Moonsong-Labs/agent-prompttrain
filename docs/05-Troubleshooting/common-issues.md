# Troubleshooting Guide

## Common Issues

### Authentication Error: Invalid x-api-key

**Error Message:**

```
authentication_error: invalid x-api-key
```

**Causes:**

1. Invalid or expired Claude API key
2. Using wrong API key format
3. API key not properly configured

**Solutions:**

1. **Check API Key Format**
   - Claude API keys should start with `sk-ant-`
   - OAuth tokens should use `Bearer` prefix

2. **Verify Credential Files**

   ```bash
   # Check if credential files exist
   ls -la credentials/

   # Verify the credential file for your trainId
   cat credentials/your-trainId.credentials.json
   ```

3. **Test API Key Directly**

   ```bash
   # Test with curl using your API key
   curl https://api.anthropic.com/v1/messages \
     -H "x-api-key: sk-ant-..." \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{
       "model": "claude-3-sonnet-20240229",
       "max_tokens": 10,
       "messages": [{"role": "user", "content": "Hi"}]
     }'
   ```

4. **Check Credential Files**

   ```bash
   # List credential files
   ls -la credentials/

   # Check credential file format
   cat credentials/your-trainId.credentials.json
   ```

   **Note:** The proxy will warn once when a trainId doesn't have a credential file:

   ```
   WARN: No credential file found for train: train-alpha
   ```

   This helps identify missing credential configurations.

5. **Use Request Headers**
   - Pass API key in request: `Authorization: Bearer sk-ant-...`
   - Or use: `x-api-key: sk-ant-...`

### Slack Notification Errors

**Error Message:**

```
TypeError: undefined is not an object (evaluating 'content.length')
```

**Status:** Fixed in latest version

**Solution:**

- Update to latest proxy build
- Restart proxy service

### Database Connection Issues

**Error Message:**

```
Database configuration is required for dashboard service
```

**Solutions:**

1. **Set DATABASE_URL**

   ```bash
   export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
   ```

2. **Initialize Database**

   ```bash
   bun run db:init
   ```

3. **Check Connection**
   ```bash
   psql $DATABASE_URL -c "SELECT 1"
   ```

### Memory Leaks in Dashboard

**Symptoms:**

- Growing memory usage
- Browser becoming slow
- Timeline chart growing indefinitely

**Status:** Fixed in latest version

**Solution:**

- Update dashboard service
- Clear browser cache
- Restart dashboard

### Service Won't Start

**Error Message:**

```
process.on is not a function
```

**Cause:** Issue with bundler minification

**Solutions:**

1. Use development mode: `bun run dev`
2. Or use the start script: `./start-dashboard.sh`
3. Build without minification (already applied)

## Debug Mode

Enable debug logging for more information:

```bash
# Enable debug mode
export DEBUG=true
export LOG_LEVEL=debug

# Start services
bun run dev
```

## Getting Help

1. Check logs for detailed error messages
2. Enable debug mode for more information
3. Check GitHub issues
4. Contact support with:
   - Error message
   - Steps to reproduce
   - Environment details
