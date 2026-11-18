// oxlint-disable shadcn/no-raw-colors -- A third-party mark keeps its exact colors.
import { type SVGProps, useId } from "react";

import type { Icon } from "../components/Icons";

/** Rexie from Rex for Mac's app icon: its head and eye layers, from the app's asset catalog. */
export const RexIcon: Icon = (props: SVGProps<SVGSVGElement>) => {
  const gradientId = `${useId()}-rex-head`;
  return (
    <svg {...props} fill="none" viewBox="10 10 432 432">
      <defs>
        <radialGradient
          id={gradientId}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(-203.759 376.206 -377.908 -204.43 347.433 53.515)"
        >
          <stop stopColor="#FFFF32" />
          <stop offset="0.430529" stopColor="#FF6F38" />
          <stop offset="0.792483" stopColor="#BE6DFF" />
          <stop offset="1" stopColor="#5FE4FF" />
        </radialGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M165.101 20.2002C177.761 14.2037 199.028 31.8974 209.052 46.3272C212.343 45.6689 215.67 45.0764 219.027 44.5469C320.017 28.6171 411.702 77.9447 423.811 154.721C434.486 222.423 379.712 288.85 297.368 314.531L297.372 314.563C275.207 320.528 237.141 326.793 201.935 328.174C198.618 328.304 197.923 332.549 201.113 333.465C223.959 340.024 261.108 347.29 294.569 345.421C294.584 345.52 294.599 345.62 294.615 345.72C284.024 387.427 246.975 421.603 204.141 428.36C151.731 436.627 102.096 406.429 83.6742 358.599C62.9143 351.82 48.1818 342.991 47.2582 331.216C45.4843 308.6 73.807 312.042 70.3871 290.349C66.6684 266.772 26.1737 276.574 24.0307 249.365C22.1324 225.195 58.6755 229.318 56.9906 202.226C55.6276 180.35 16.8464 172.786 23.5863 149.633C30.6064 125.526 68.0205 142.323 80.7924 124.231C93.4271 106.325 65.7286 83.5368 80.9487 67.5352C97.8405 49.7837 123.326 80.9928 142.656 70.3506C162.098 59.6442 146.041 29.2355 165.101 20.2002Z"
      />
      <path
        fill="#1E015C"
        fillRule="evenodd"
        transform="translate(152 224)"
        d="M21.2442 0.495227C35.848 -2.73647 51.3128 10.188 55.7818 29.3549C60.2485 48.5226 52.0268 66.6824 37.4229 69.9146C22.8191 73.1441 7.36007 60.2212 2.89235 41.0538C-1.57236 21.8878 6.64169 3.72764 21.2442 0.495227Z"
      />
    </svg>
  );
};
