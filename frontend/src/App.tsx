import { Routes, Route } from "react-router-dom";
import Landing from "@/pages/Landing";
import Pos from "@/pages/Pos";
import History from "@/pages/History";
import Login from "@/pages/Login";
import Admin from "@/pages/Admin";
import PublicMenu from "@/pages/PublicMenu";
import RequireAuth from "@/components/RequireAuth";

// One <Route> per page in src/pages; BrowserRouter already wraps this in main.tsx.
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      {/* customer side (public — order on phone, pay at the counter) */}
      <Route path="/m/:code" element={<PublicMenu />} />
      <Route path="/pos" element={<RequireAuth><Pos /></RequireAuth>} />
      <Route path="/history" element={<RequireAuth><History /></RequireAuth>} />
      <Route path="/admin" element={<RequireAuth ownerOnly><Admin /></RequireAuth>} />
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}
