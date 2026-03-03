import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { McpServerConfig } from '../../types/mcp';

interface McpState {
  servers: McpServerConfig[];
}

const initialState: McpState = {
  servers: [],
};

const mcpSlice = createSlice({
  name: 'mcp',
  initialState,
  reducers: {
    setMcpServers: (state, action: PayloadAction<McpServerConfig[]>) => {
      state.servers = action.payload;
    },
    toggleMcpServer: (state, action: PayloadAction<string>) => {
      const server = state.servers.find(s => s.id === action.payload);
      if (server) {
        server.enabled = !server.enabled;
      }
    },
  },
});

export const {
  setMcpServers,
  toggleMcpServer,
} = mcpSlice.actions;

export default mcpSlice.reducer;
