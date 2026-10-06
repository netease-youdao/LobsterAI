import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { EnterpriseAccountContext } from '../../../shared/enterpriseAccount/types';
import { setLoggedOut } from '../../store/slices/authSlice';

interface EnterpriseAccountState {
  context: EnterpriseAccountContext | null;
}

const initialState: EnterpriseAccountState = {
  context: null,
};

const enterpriseAccountSlice = createSlice({
  name: 'enterpriseAccount',
  initialState,
  reducers: {
    setEnterpriseAccountContext(
      state,
      action: PayloadAction<EnterpriseAccountContext | null>,
    ) {
      state.context = action.payload;
    },
  },
  extraReducers: builder => {
    builder.addCase(setLoggedOut, state => {
      state.context = null;
    });
  },
});

export const { setEnterpriseAccountContext } = enterpriseAccountSlice.actions;
export default enterpriseAccountSlice.reducer;
