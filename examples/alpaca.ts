import { AlpacaDiscoveryServer } from '../src/alpaca.server'

const alpacaDiscovery = new AlpacaDiscoveryServer([2222])
await alpacaDiscovery.start('0.0.0.0')
