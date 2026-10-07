import { handleGenerate } from './_lib/handlers.js'
import { nodeHandler } from './_lib/nodeHandler.js'

export const maxDuration = 60

export default nodeHandler(handleGenerate)
