import type { GetStaticPaths, GetStaticProps } from 'next';

type Props = { slug: string; timestamp: number; counter: number };

// Per-process regeneration counter. Two server instances of the same build
// have independent counters, while the timestamp proves cross-instance
// freshness after on-demand revalidation.
let regenerationCounter = 0;

export default function IsrPage({ slug, timestamp, counter }: Props) {
  return (
    <main>
      <h1>ISR page</h1>
      <p>Slug: {slug}</p>
      <p>Timestamp: {timestamp}</p>
      <p>Counter: {counter}</p>
    </main>
  );
}

export const getStaticPaths: GetStaticPaths = async () => {
  return {
    paths: [{ params: { slug: 'prebuilt' } }],
    fallback: 'blocking',
  };
};

// revalidate is set high (300s) so that natural ISR regeneration does not
// interfere with the on-demand revalidation (res.revalidate) tests.
export const getStaticProps: GetStaticProps<Props> = async (context) => {
  const slug = context.params?.slug as string;

  if (slug === 'not-found') {
    return { notFound: true, revalidate: 300 };
  }

  if (slug === 'redirect') {
    return {
      redirect: { destination: '/static-forever', permanent: false },
      revalidate: 300,
    };
  }

  regenerationCounter += 1;
  return {
    props: { slug, timestamp: Date.now(), counter: regenerationCounter },
    revalidate: 300,
  };
};
