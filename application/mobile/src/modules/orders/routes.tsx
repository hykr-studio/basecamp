import { useLocalSearchParams } from 'expo-router';
import { OrderDetail } from './screens/OrderDetail';

export { Orders as OrdersRoute } from './screens/Orders';

/** /orders/:id: the order screen (also shown in the canvas, bound in index.tsx). */
export function OrderRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <OrderDetail id={id} />;
}
