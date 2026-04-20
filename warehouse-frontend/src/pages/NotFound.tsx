import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-gray-300 mb-4">404</h1>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">
          Страницата не е намерена
        </h2>
        <p className="text-gray-500 mb-6">
          Страницата, която търсите, не съществува или е била преместена.
        </p>
        <Button onClick={() => navigate("/")}>Към началната страница</Button>
      </div>
    </div>
  );
}
