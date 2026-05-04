import { redirect } from 'react-router';

export async function clientLoader() {
  return redirect('/mail/inbox');
}

export default function Home() {
  return null;
}
