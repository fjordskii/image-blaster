import { handleWorlds } from './lib/handlers'
import { nodeHandler } from './lib/nodeHandler'

export const maxDuration = 60

export default nodeHandler(handleWorlds)
