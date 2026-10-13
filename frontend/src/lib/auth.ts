import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiGet } from "@/lib/api";
import type { Me, PublicStore, Store } from "@/lib/types";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await apiGet<Me>("/auth/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function usePublicStores() {
  return useQuery({ queryKey: ["public-stores"], queryFn: () => apiGet<PublicStore[]>("/public/stores") });
}

const KEY = "nb-store";

/** Store the signed-in user is working in. Cashiers are pinned; the owner picks one (remembered on this device). */
export function useActiveStore() {
  const me = useMe();
  const storesQ = useQuery({ queryKey: ["stores"], queryFn: () => apiGet<Store[]>("/stores"), enabled: !!me.data });
  const stores = storesQ.data ?? [];
  const [picked, setPicked] = useState<string | null>(() => localStorage.getItem(KEY));
  const isOwner = me.data?.role === "owner";
  const storeId = isOwner ? (stores.find((s) => s.id === picked)?.id ?? stores[0]?.id ?? null) : (me.data?.store_id ?? null);
  const store = stores.find((s) => s.id === storeId) ?? null;
  const setStore = (id: string) => {
    localStorage.setItem(KEY, id);
    setPicked(id);
  };
  return { me: me.data ?? null, isOwner, stores, storeId, store, setStore };
}
