import { AlpacaDiscoveryClient } from '../src/alpaca.discovery'

const alpacaDiscoveryClient = new AlpacaDiscoveryClient()
await alpacaDiscoveryClient.discovery(console.info, { timeout: 5000 })
