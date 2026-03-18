import { memo } from 'react'
import Avatar from 'boring-avatars'

const PALETTE = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51']

type UserAvatarProps = {
  /** User name used as the seed for deterministic generation. */
  name: string
  /** Pixel size. Defaults to 40. */
  size?: number
}

/**
 * Deterministic SVG avatar generated from the user's name.
 * No database storage or external API calls required.
 */
export const UserAvatar = memo(function UserAvatar({
  name,
  size = 40,
}: UserAvatarProps) {
  return <Avatar size={size} name={name} variant="beam" colors={PALETTE} />
})
